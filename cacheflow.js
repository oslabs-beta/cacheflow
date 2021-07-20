const fs = require('fs');
const redis = require('redis');
const { promisify } = require('util');

/*
----------------------------------------------------------------------------
TEST FUNCTION: testMsg(){}

Test to make sure npm package is connected

*/

exports.cacheflowTestMsg = function () {
  console.log('This is a test message from cacheflow');
  return 'This is a test message from cacheflow';
};

/*
GLOBAL VARIABLES

client: connection to redis 
globalLocalThreshold: default threshold initialized from configObj.local.globalThreshold
*/

let client;
let globalLocalThreshold;

/*
----------------------------------------------------------------------------
INITIALIZE CACHE FUNCTION: initCache(){}

If user wants to cache they must initialize the cache locations by using these.

Create base files: localMetricsStorage.json and globalMetrics.json

  totalNumberOfRequests: total number of all requests  
  averageNumberOfCalls: average number of requests per resolver
  numberOfUncachedRequests: total number of uncached requests
  numberOfCachedRequests: total number of cached requests
  totalTimeSaved: total amount of time saved by caching in ms
  averageUncachedLatency: average length of uncached query per resolver
  averageCachedLatency: average length of cached query per resolver
  totalUncachedElapsed: total request latency uncached
  totalCachedElapsed: total request latency cached
  globalAverageCallSpan: average time between resolver calls
  uniqueResolvers: total number of resolvers called
  sizeOfDataRedis: total amount of data saved in redis in bytes
  sizeOfDataLocal: total amount of data saved locally in bytes
  averageSizeOfDataLocal: average amount of data saved locally per resolver
  averageCacheThreshold: 0

If user specified to intialize local storage, localStorage.json is created
If user specified to intialize redis storage, client is created and connected
Data cleaning interval is initialized

*/

exports.initCache = async function (configObj) {
  if (!fs.existsSync('cacheflowSrc')) {
    fs.mkdirSync('cacheflowSrc');
  }
  fs.writeFileSync('cacheflowSrc/localMetricsStorage.json', '{}');
  fs.writeFileSync(
    'cacheflowSrc/globalMetrics.json',
    JSON.stringify({
      totalNumberOfRequests: 0,
      averageNumberOfCalls: 0,
      numberOfUncachedRequests: 0,
      numberOfCachedRequests: 0,
      totalTimeSaved: 0,
      averageUncachedLatency: 0,
      averageCachedLatency: 0,
      totalUncachedElapsed: 0,
      totalCachedElapsed: 0,
      globalAverageCallSpan: 0,
      uniqueResolvers: 0,
      sizeOfDataRedis: 0,
      sizeOfDataLocal: 0,
      averageSizeOfDataLocal: 0,
      averageCacheThreshold: 0,
    })
  );

  if (configObj.local) {
    fs.writeFileSync(`cacheflowSrc/localStorage.json`, '{}');
    globalLocalThreshold = configObj.local.globalThreshold / 1000;
  }

  if (configObj.redis) {
    client = redis.createClient({
      host: configObj.redis.host,
      port: configObj.redis.port,
      password: configObj.redis.password,
    });

    client.on('error', (err) => {
      throw new Error('ERROR CONNECTING TO REDIS');
    });
  }

  setInterval(() => {
    clean();
  }, configObj.local.checkExpire * 1000 || 10000);
};

/*
-------------------------------------------------------------
CACHE FUNCTION: cache(cachedConfig: Object that is passed in by user, info, callback){}
If cacheConfig is incorrect throw error
If cacheConfig.location is local call cachLocal
If cacheConfig.location is redis call cacheRedis
*/

exports.cache = function (cacheConfig = {}, info, callback) {
  const startDate = Date.now();
  if (typeof cacheConfig !== 'object' || Array.isArray(cacheConfig))
    throw new Error('Config object is invalid');
  if (cacheConfig.location === 'local') {
    return cacheLocal(cacheConfig, info, callback, startDate);
  }
  if (cacheConfig.location === 'redis') {
    return cacheRedis(cacheConfig, info, callback, startDate);
  }
};

/*
-------------------------------------------------------------
LOCAL CACHE FUNCTION: cacheLocal() {}
If resolver was a mutation call mutateLocal
If resolver already in local cache call localFound
If resolver was not in local cache call localNotFound
*/

async function cacheLocal(cacheConfig, info, callback, startDate) {
  const metrics = fsRead('cacheflowSrc/localMetricsStorage.json');
  if (cacheConfig.mutate) {
    if (!metrics[cacheConfig.mutate]) {
      throw new Error('Data does not exist in local cache');
    }
    return mutateLocal(cacheConfig, callback);
  }
  const parsedData = fsRead('cacheflowSrc/localStorage.json');
  if (parsedData[info.path.key]) {
    return localFound(cacheConfig, info, startDate, parsedData);
  } else {
    return localNotFound(cacheConfig, info, callback, startDate, parsedData);
  }
}

/*
-------------------------------------------------------------
MUTATE LOCAL FUNCTION: mutateLocal() {}
Update localStorage for the resolver the mutation was called on 
Call mutationMetrics with the resolver name
Return data from the callback
*/

async function mutateLocal(cacheConfig, callback) {
  const parsedData = fsRead('cacheflowSrc/localStorage.json');
  const dataBack = await callback();
  parsedData[cacheConfig.mutate] = {
    data: dataBack,
    expire: Date.now() + cacheConfig.maxAge * 1000,
  };
  fsWrite('cacheflowSrc/localStorage.json', parsedData);
  mutationMetrics(cacheConfig.mutate, dataBack);
  return parsedData[cacheConfig.mutate].data;
}

/*
-------------------------------------------------------------
LOCAL FOUND FUNCTION: localFound() {}
Read and parse localStorage.json
Time stamp and log latency
Update expiration date
Call metrics with cachedLatency 
Update cache and return cached data
*/

function localFound(cacheConfig, info, startDate, parsedData) {
  const currentTime = Date.now();
  const requestLatencyCached = currentTime - startDate;
  parsedData[info.path.key].expire = currentTime + cacheConfig.maxAge * 1000;
  metrics({ cachedLatency: requestLatencyCached }, info);
  const globalMetrics = fsRead('cacheflowSrc/globalMetrics.json');
  globalMetrics.numberOfCachedRequests++;
  globalMetrics.totalCachedElapsed += requestLatencyCached;
  globalMetrics.averageCachedLatency =
    globalMetrics.totalCachedElapsed / globalMetrics.numberOfCachedRequests;
  fsWrite('cacheflowSrc/globalMetrics.json', globalMetrics);
  fsWrite('cacheflowSrc/localStorage.json', parsedData);
  return parsedData[info.path.key].data;
}

/*
-------------------------------------------------------------
LOCAL NOT FOUND FUNCTION: localNotFound() {}
Run callback to generate data
Time stamp
Add new data to parsed object
Log metrics
Cache new data and return new data

Threshold defaults to global variable globalLocalThreshold unless user has specific  
threshold for that resolver on resolver's cacheConfig object

Smartcache gets called to see if data should be cached or not 
*/

async function localNotFound(
  cacheConfig,
  info,
  callback,
  startDate,
  parsedData
) {
  const resolverName = info.path.key;
  const returnData = await callback();
  const currentTime = Date.now();
  const requestLatencyUncached = currentTime - startDate;

  let localMetrics = fsRead('cacheflowSrc/localMetricsStorage.json');
  let threshold;
  let inMetricCheck = false;

  if (!localMetrics[resolverName]) {
    inMetricCheck = true;
    metrics(
      {
        uncachedLatency: requestLatencyUncached,
        returnData,
        storedLocation: 'local',
      },
      info
    );
  }

  localMetrics = fsRead('cacheflowSrc/localMetricsStorage.json');
  cacheConfig.threshold
    ? (threshold = cacheConfig.threshold / 1000)
    : (threshold = globalLocalThreshold);
  const globalMetrics = fsRead('cacheflowSrc/globalMetrics.json');

  const allCalls = localMetrics[resolverName].allCalls;
  const numberCalls = localMetrics[resolverName].numberOfCalls;
  let frequency;

  allCalls.length === 1
    ? (frequency = 0)
    : (frequency = numberCalls / (allCalls[allCalls.length - 1] - allCalls[0]));

  let smartCacheValue = null;
  if (inMetricCheck === false) {
    smartCacheValue = smartCache(localMetrics, globalMetrics, resolverName);
  }

  if (frequency >= threshold || smartCacheValue) {
    parsedData[resolverName] = {
      data: returnData,
      expire: currentTime + cacheConfig.maxAge * 1000,
    };
    globalMetrics.numberOfCachedRequests++;

    fsWrite('cacheflowSrc/globalMetrics.json', globalMetrics);
    fsWrite('cacheflowSrc/localStorage.json', parsedData);
    return returnData;
  } else {
    if (inMetricCheck === false) {
      metrics(
        {
          uncachedLatency: requestLatencyUncached,
          returnData,
          storedLocation: 'local',
        },
        info
      );
    }

    const globalMetrics = fsRead('cacheflowSrc/globalMetrics.json');
    globalMetrics.numberOfUncachedRequests++;
    globalMetrics.totalUncachedElapsed += requestLatencyUncached;
    globalMetrics.averageUncachedLatency =
      globalMetrics.totalUncachedElapsed /
      globalMetrics.numberOfUncachedRequests;

    fsWrite('cacheflowSrc/globalMetrics.json', globalMetrics);
  }
  return returnData;
}

/*
-------------------------------------------------------------
SMART CACHE FUNCTION: smartCache() {}
Uses number of calls, time between calls and size of data to make one comparison variable value
Uses the value variable from above and compares it to average data for all resolvers 
If value is greater than the average threshold value for all resolvers return true, else return false
*/

const smartCache = (metricsData, globalMetrics, resolverName) => {
  const defaultThreshold = 1;

  let numberCalls =
    (metricsData[resolverName].numberOfCalls -
      globalMetrics.averageNumberOfCalls) /
    globalMetrics.averageNumberOfCalls;

  let temp;
  metricsData[resolverName].averageCallSpan === 'Insufficient Data'
    ? (temp = 10000)
    : (temp = metricsData[resolverName].averageCallSpan);
  let callSpan = metricsData[resolverName].averageCallSpan;
  callSpan <= 0 ? (callSpan = 5000) : null;

  let dataSize =
    (metricsData[resolverName].dataSize -
      globalMetrics.averageSizeOfDataLocal) /
    300;

  const value = numberCalls + (1 / (0.004 * temp)) * 0.92 + dataSize * 0.17;

  if (value > defaultThreshold * 0.97) {
    globalMetrics.averageCacheThreshold =
      (defaultThreshold + value) /
      (globalMetrics.totalNumberOfRequests === 0
        ? 1
        : globalMetrics.totalNumberOfRequests);

    metricsData[resolverName].cacheThreshold = value;
    fsWrite('cacheflowSrc/localMetricsStorage.json', metricsData);
    fsWrite('cacheflowSrc/globalMetrics.json', globalMetrics);
    return true;
  }
  fsWrite('cacheflowSrc/globalMetrics.json', globalMetrics);
  return false;
};

/*
-------------------------------------------------------------
MUTATE REDIS FUNCTION: redisMutate() {}
New data is generated from callback
Set new mutated data to redis store with new expiration date
Call mutationMetrics to update metrics
Return new mutated data
*/

async function redisMutate(cacheConfig, callback, startDate) {
  const returnData = await callback();
  client.set(cacheConfig.mutate, JSON.stringify(returnData));
  client.expire(cacheConfig.mutate, cacheConfig.maxAge);
  mutationMetrics(cacheConfig.mutate, returnData);
  return returnData;
}

/*
-------------------------------------------------------------
CACHE REDIS FUNCTION: cacheRedis() {}
Must promisify redis client.get function
If user is mutating data, run reisMutate function
Else see if data is in redis store or not, if not cache it and set metrics, else update expiration date and call metrics 
*/

async function cacheRedis(cacheConfig, info, callback, startDate) {
  const getAsync = promisify(client.get).bind(client);
  const resolverName = info.path.key;
  let redisData;
  let responseTime;

  if (cacheConfig.mutate) {
    return redisMutate(cacheConfig, callback, startDate);
  }

  await getAsync(resolverName).then(async (res) => {
    if (res === null) {
      const returnData = await callback();
      client.set(resolverName, JSON.stringify(returnData));
      client.expire(resolverName, cacheConfig.maxAge);
      redisData = returnData;
      responseTime = Date.now() - startDate;
      metrics(
        {
          uncachedLatency: responseTime,
          storedLocation: 'redis',
          returnData,
        },
        info
      );
    } else {
      redisData = JSON.parse(res);
      client.expire(resolverName, cacheConfig.maxAge);
      responseTime = Date.now() - startDate;
      metrics({ cachedLatency: responseTime }, info);
    }
  });

  return redisData;
}

/*
-------------------------------------------------------------
MUTATE METRICS FUNCTION: mutationMetrics() {}
Update metrics about size of data size of specific resolver after a mutation  
Update metrics about size of data size in global cache after a mutation 
*/

function mutationMetrics(mutateName, data) {
  const jsonLocal = fsRead('cacheflowSrc/localMetricsStorage.json');
  const jsonGlobal = fsRead('cacheflowSrc/globalMetrics.json');

  const oldSize = jsonLocal[mutateName].dataSize;
  const newSize = sizeOf(data);

  jsonLocal[mutateName].dataSize = newSize;

  jsonGlobal.sizeOfDataLocal += newSize - oldSize;

  fsWrite('cacheflowSrc/localMetricsStorage.json', jsonLocal);
  fsWrite('cacheflowSrc/globalMetrics.json', jsonGlobal);
}

/*
-------------------------------------------------------------
METRICS FUNCTION: metrics() {}
If resolver in cache call localMetricsUpdate
If resolver not in cache call setLocalMetric
Always call globalMetrics
*/

async function metrics(resolverData, info) {
  let parsedMetrics = fsRead('cacheflowSrc/localMetricsStorage.json');

  if (parsedMetrics[info.path.key]) {
    await localMetricsUpdate(resolverData, info, parsedMetrics);
  } else {
    await setLocalMetric(resolverData, info, parsedMetrics);
  }
  await globalMetrics(resolverData, info, parsedMetrics);
}

/*
-------------------------------------------------------------
SET LOCAL METRICS FUNCTION: setLocalMetric() {}
Update localMetricsStorage with new resolver 

firstCall: timestamp from first call
allCalls: array of timestamps from calls
numberOfCalls: total number of calls for resolver
averageCallSpan: average time between calls
uncachedCallTime: length of uncached query 
cachedCallTime: length of cached query
dataSize: size of data
storedLocation: where the data is stored
*/

function setLocalMetric(resolverData, info, parsedMetrics) {
  globalMetricsParsed = fsRead('cacheflowSrc/globalMetrics.json');
  parsedMetrics[info.path.key] = {
    firstCall: Date.now(),
    allCalls: [Date.now()],
    numberOfCalls: 1,
    averageCallSpan: 'Insufficient Data',
    uncachedCallTime: resolverData.uncachedLatency,
    cachedCallTime: null,
    dataSize: sizeOf(resolverData.returnData),
    storedLocation: resolverData.storedLocation,
    cacheThreshold: null,
  };
  fsWrite('cacheflowSrc/localMetricsStorage.json', parsedMetrics);

  resolverData.storedLocation === 'local'
    ? (globalMetricsParsed.sizeOfDataLocal += sizeOf(resolverData.returnData))
    : null;

  fsWrite('cacheflowSrc/globalMetrics.json', globalMetricsParsed);
}

/*
-------------------------------------------------------------
LOCAL METRICS UPDATE FUNCTION: cacheRedis() {}
Updates allCalls to be array with only last ten calls to resolver
Updates averageCallSpan to be length of time between last call and tenth call ago
Increments numberOfCalls by one
Sets cached call time equal to how long the cached request took
*/

function localMetricsUpdate(resolverData, info, parsedMetrics) {
  const resolverName = info.path.key;
  const date = Date.now();

  let allCalls = parsedMetrics[resolverName].allCalls;
  allCalls.push(date);
  allCalls.length > 10 ? allCalls.shift() : allCalls;

  if (resolverData.uncachedLatency) {
    parsedMetrics[resolverName].uncachedCallTime = resolverData.uncachedLatency;
  }

  parsedMetrics[resolverName].averageCallSpan =
    (date - allCalls[0]) / allCalls.length;
  parsedMetrics[resolverName].numberOfCalls += 1;
  parsedMetrics[resolverName].cachedCallTime = resolverData.cachedLatency;

  fsWrite('cacheflowSrc/localMetricsStorage.json', parsedMetrics);
}

/*
-------------------------------------------------------------
GLOBAL METRICS FUNCTION: globalMetrics() {}
Increments totalNumberOfRequests by one
Increments totalTimeSaved by the difference between the cached and uncached requests for that resolver
Updates amount of data saved locally
*/

function globalMetrics(resolverData, info, parsedMetrics) {
  const resolverName = info.path.key;
  const numOfResolvers = Object.keys(parsedMetrics).length;
  let globalMetricsParsed = fsRead('cacheflowSrc/globalMetrics.json');

  globalMetricsParsed.totalNumberOfRequests++;

  globalMetricsParsed.averageNumberOfCalls =
    globalMetricsParsed.totalNumberOfRequests / numOfResolvers;

  globalMetricsParsed.totalTimeSaved +=
    parsedMetrics[resolverName].uncachedCallTime -
    parsedMetrics[resolverName].cachedCallTime;

  globalMetricsParsed.uniqueResolvers = numOfResolvers;

  globalMetricsParsed.averageSizeOfDataLocal =
    globalMetricsParsed.sizeOfDataLocal / numOfResolvers;

  let globalAvgCallSpan = 0;
  for (const item in parsedMetrics) {
    globalAvgCallSpan += parsedMetrics[item].averageCallSpan;
  }
  globalMetricsParsed.globalAverageCallSpan =
    globalAvgCallSpan / globalMetricsParsed.uniqueResolvers;

  fsWrite('cacheflowSrc/globalMetrics.json', globalMetricsParsed);
}

/*
-------------------------------------------------------------
CLEAN STORAGE FUNCTION: clean() {}
Checks if any data stored locally is set to expire, deletes it from localStorage if its expire property is greater than Date.now()
Updates local metrics for that resolver and global metrics
*/

function clean() {
  const dateNow = Date.now();

  let parsedData = fsRead('cacheflowSrc/localStorage.json');
  let parsedGlobalData = fsRead('cacheflowSrc/globalMetrics.json');
  let parsedLocalData = fsRead('cacheflowSrc/localMetricsStorage.json');

  let sizeOfDeletedDataLocal = 0;

  for (let resolver in parsedData) {
    if (dateNow > parsedData[resolver].expire) {
      sizeOfDeletedDataLocal += parsedLocalData[resolver].dataSize;
      parsedLocalData[resolver].dataSize = 0;
      delete parsedData[resolver];
    }
  }

  if (client) {
    client.info((req, res) => {
      res.split('\n').map((line) => {
        if (line.match(/used_memory:/)) {
          parsedGlobalData.sizeOfDataRedis = parseInt(line.split(':')[1]);
          parsedGlobalData.sizeOfDataLocal -= sizeOfDeletedDataLocal;

          fsWrite('cacheflowSrc/globalMetrics.json', parsedGlobalData);
        }
      });
    });
  }

  fsWrite('cacheflowSrc/localStorage.json', parsedData);
  fsWrite('cacheflowSrc/localMetricsStorage.json', parsedLocalData);
}

/*
-------------------------------------------------------------
FS FUNCTIONS: 
fsRead(){}
fsWrite(){}
*/

function fsRead(fileName) {
  const data = fs.readFileSync(`${fileName}`, 'utf-8');
  const json = JSON.parse(data);
  return json;
}

function fsWrite(fileName, data) {
  fs.writeFileSync(`${fileName}`, JSON.stringify(data), (err) => {
    if (err) throw new Error(err);
  });
}

/*
-------------------------------------------------------------
DATA SIZE FUNCTION: sizeOf() {}
Returns an estimated size of input data in bytes
*/

const typeSizes = {
  undefined: () => 0,
  boolean: () => 4,
  number: () => 8,
  string: (item) => 2 * item.length,
  object: (item) =>
    !item
      ? 0
      : Object.keys(item).reduce(
          (total, key) => sizeOf(key) + sizeOf(item[key]) + total,
          0
        ),
};

const sizeOf = (value) => typeSizes[typeof value](value);
