const fs = require('fs');
const redis = require('redis');
const { promisify } = require('util');

////////////
//add average uncached vs cached latency ion global metrics
////////////

exports.testMsg = function () {
  console.log('This is a test message from cacheflow');
};

let client;
let globalLocalThreshold; // = 10

/*
----------------------------------------------------------------------------
INITIALIZE CACHE FUNCTION: initCache(){}

if user wants to cache they must initialize the cache locations by using these.

Create base files: localMetricsStorage.json and globalMetrics.json
If user specified to intialize local storage, localStorage.json is created
If user specified to intialize redis storage, client is created and connected
Data cleaning interval is initialized

*/

exports.initCache = function (configObj) {
  fs.writeFileSync('localMetricsStorage.json', '{}');
  fs.writeFileSync(
    'globalMetrics.json',
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
    fs.writeFileSync(`localStorage.json`, '{}');
    globalLocalThreshold = configObj.local.globalThreshold / 1000;
  }

  if (configObj.redis) {
    client = redis.createClient({
      host: configObj.redis.host,
      port: configObj.redis.port,
      password: configObj.redis.password,
    });

    client.on('error', (err) => {
      throw new Error(err);
    });
  }

  setInterval(() => {
    clean();
  }, configObj.local.checkExpire * 1000);
};

/*
-------------------------------------------------------------
CACHE FUNCTION: cache(cachedConfig: Object that is passed in by user, info, callback){

}

Check to see it cacheConfig is valid
If cacheConfig.location is local call cachLocal
If cacheConfig.location is redis call cacheRedis

*/

exports.cache = async function (cacheConfig = {}, info, callback) {
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
LOCAL CACHE FUNCTION: cacheLocal() {
  
}
IF RESOLVER WAS A MUTATION CALL mutateLocal

IF RESOLVER FOUND IN CACHE CALL localFound

IF RESOLVER NOT FOUND IN CACHE CALL localNotFound


*/

async function cacheLocal(cacheConfig, info, callback, startDate) {
  const metrics = fsRead('localMetricsStorage.json');
  if (cacheConfig.mutate) {
    if (!metrics[cacheConfig.mutate]) {
      throw new Error('Data does not exist in local cache');
    }
    return mutateLocal(cacheConfig, callback);
  }
  const parsedData = fsRead('localStorage.json');
  if (parsedData[info.path.key]) {
    return localFound(cacheConfig, info, startDate, parsedData);
  } else {
    return localNotFound(cacheConfig, info, callback, startDate, parsedData);
  }
}

/*
-------------------------------------------------------------
MUTATE LOCAL FUNCTION: mutateLocal() {}

READ LOCALSTORAGE JSON FILE
RE-RUN THE CALLBACK FOR NEW MUTATED DATA
UPDATE THE LOCALSTORAGE JSON FILE
RUN MUTATIONMETRICS FUNCTION
RETURN NEW MUTATED DATA

*/

async function mutateLocal(cacheConfig, callback) {
  const parsedData = fsRead('localStorage.json');
  const dataBack = await callback();
  parsedData[cacheConfig.mutate] = {
    data: dataBack,
    expire: Date.now() + cacheConfig.maxAge * 1000,
  };
  fsWrite('localStorage.json', parsedData);
  mutationMetrics(cacheConfig.mutate, dataBack);
  return parsedData[cacheConfig.mutate].data;
}

/*
-------------------------------------------------------------
LOCAL FOUND FUNCTION: localFound() {}

Read and parse localStorage.json
Time stamp and log latency
Update expiration date
Log metrics
Update cache and return cached data

*/

function localFound(cacheConfig, info, startDate, parsedData) {
  const currentTime = Date.now();
  const requestLatencyCached = currentTime - startDate;
  parsedData[info.path.key].expire = currentTime + cacheConfig.maxAge * 1000;
  metrics({ cachedLatency: requestLatencyCached }, info);
  const globalMetrics = fsRead('globalMetrics.json');
  globalMetrics.numberOfCachedRequests++;
  globalMetrics.totalCachedElapsed += requestLatencyCached;
  globalMetrics.averageCachedLatency =
    globalMetrics.totalCachedElapsed / globalMetrics.numberOfCachedRequests;
  fsWrite('globalMetrics.json', globalMetrics);
  fsWrite('localStorage.json', parsedData);
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

Threshold defaults to globalLocalThreshold unless user inputs 
threshold on their cacheConfig object

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

  let localMetrics = fsRead('localMetricsStorage.json');
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

  localMetrics = fsRead('localMetricsStorage.json');
  cacheConfig.threshold
    ? (threshold = cacheConfig.threshold / 1000)
    : (threshold = globalLocalThreshold);
  const globalMetrics = fsRead('globalMetrics.json');

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
    // if the threshold is met or smartCache returns true
    parsedData[resolverName] = {
      data: returnData,
      expire: currentTime + cacheConfig.maxAge * 1000,
    };
    globalMetrics.numberOfCachedRequests++;

    fsWrite('globalMetrics.json', globalMetrics);
    fsWrite('localStorage.json', parsedData);
    return parsedData[resolverName].data;
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

    const globalMetrics = fsRead('globalMetrics.json');
    globalMetrics.numberOfUncachedRequests++;
    globalMetrics.totalUncachedElapsed += requestLatencyUncached;
    globalMetrics.averageUncachedLatency =
      globalMetrics.totalUncachedElapsed /
      globalMetrics.numberOfUncachedRequests;

    fsWrite('globalMetrics.json', globalMetrics);
  }
  return returnData;
}

/*
WE HAVE TO KEEP TRACK OF MAX AGE AS WELL

 
*/
const smartCache = (metricsData, globalMetrics, resolverName) => {
  const defaultThreshold = 1; //I have no idea what this should be yet
  // let THRESHOLD;
  // console.log('avg cache threshold', globalMetrics.averageCacheThreshold);
  // globalMetrics.averageCacheThreshold === 0 || null
  //   ? (THRESHOLD = defaultThreshold)
  //   : (THRESHOLD = globalMetrics.averageCacheThreshold);

  let numberCalls =
    (metricsData[resolverName].numberOfCalls -
      globalMetrics.averageNumberOfCalls) /
    globalMetrics.averageNumberOfCalls;

  console.log(
    '🚀 | file: cacheflow.js | line 363 | smartCache | globalMetrics.averageNumberOfCalls',
    globalMetrics.averageNumberOfCalls
  );

  console.log(
    '🚀 | file: cacheflow.js | line 365 | smartCache | metricsData[resolverName].numberOfCalls',
    metricsData[resolverName].numberOfCalls
  );

  // let numberCalls = metricsData[resolverName].numberOfCalls / 100;

  let temp;
  metricsData[resolverName].averageCallSpan === 'Insufficient Data'
    ? (temp = 10000)
    : (temp = metricsData[resolverName].averageCallSpan);
  let callSpan = metricsData[resolverName].averageCallSpan;
  //with only one resolver the global avg will be equal to the avg for that resolver
  callSpan <= 0 ? (callSpan = 5000) : null;

  let dataSize =
    (metricsData[resolverName].dataSize -
      globalMetrics.averageSizeOfDataLocal) /
    300;
  // dataSize < 0 ? (dataSize = 0) : null;

  console.log(
    'datasize local:',
    metricsData[resolverName].dataSize,
    'average datasize Global:',
    globalMetrics.averageSizeOfDataLocal
  );

  console.log('avg call span', temp);
  const value = numberCalls + (1 / (0.004 * temp)) * 0.92 + dataSize * 0.17;
  console.log(
    `numberCalls: ${numberCalls}, callSpan: ${callSpan}, dataSize: ${dataSize}`
  );

  //not sure if we are dividing by the right value

  console.log(
    '🚀 | file: cacheflow.js | line 328 | smartCache | THRESHOLD',
    defaultThreshold
  );

  console.log('🚀 | file: cacheflow.js | line 338 | smartCache | value', value);

  console.log(
    '🚀 | file: cacheflow.js | line 340 | smartCache | globalMetrics.totalNumberOfRequests',
    globalMetrics.totalNumberOfRequests
  );

  console.log(
    '🚀 | file: cacheflow.js | line 333 | smartCache | (THRESHOLD + value) / globalMetrics.totalNumberOfRequests',
    (defaultThreshold + value) / globalMetrics.totalNumberOfRequests
  );

  if (value > defaultThreshold * 0.97) {
    console.log('smartcache true');

    globalMetrics.averageCacheThreshold =
      (defaultThreshold + value) /
      (globalMetrics.totalNumberOfRequests === 0
        ? 1
        : globalMetrics.totalNumberOfRequests);

    metricsData[resolverName].cacheThreshold = value;
    fsWrite('localMetricsStorage.json', metricsData);
    fsWrite('globalMetrics.json', globalMetrics);
    return true;
  }
  console.log('smartcache false');
  fsWrite('globalMetrics.json', globalMetrics);
  return false;
};

/*
-------------------------------------------------------------
MUTATE REDIS FUNCTION: redisMutate() {}

New mutated data must be generated
Set new mutated data to redis store with new expiration date
Log mutation metrics
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
Else 

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
MUTATE METRICS FUNCTION: mutationMetrics() {
  
}

UPDATE SIZE OF DATA STORED IN LOCAL AFTER A MUTATION

UPDATE SIZE OF DATA STORED IN GLOBAL AFTER A MUTATION


*/

function mutationMetrics(mutateName, data) {
  const jsonLocal = fsRead('localMetricsStorage.json');
  const jsonGlobal = fsRead('globalMetrics.json');

  const oldSize = jsonLocal[mutateName].dataSize;
  const newSize = sizeOf(data);

  jsonLocal[mutateName].dataSize = newSize;

  jsonGlobal.sizeOfDataLocal += newSize - oldSize;

  fsWrite('localMetricsStorage.json', jsonLocal);
  fsWrite('globalMetrics.json', jsonGlobal);
}

/*
-------------------------------------------------------------
METRICS FUNCTION: metrics() {
  
}

If resolver in cache call localMetricsUpdate
If resolver not in cache call setLocalMetric
Always call globalMetrics

*/

async function metrics(resolverData, info) {
  let parsedMetrics = fsRead('localMetricsStorage.json');

  if (parsedMetrics[info.path.key]) {
    await localMetricsUpdate(resolverData, info, parsedMetrics);
  } else {
    await setLocalMetric(resolverData, info, parsedMetrics);
  }
  await globalMetrics(resolverData, info, parsedMetrics);
}

/*
-------------------------------------------------------------
SET LOCAL METRICS FUNCTION: setLocalMetric() {
  
}
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
  globalMetricsParsed = fsRead('globalMetrics.json');
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
  fsWrite('localMetricsStorage.json', parsedMetrics);

  resolverData.storedLocation === 'local'
    ? (globalMetricsParsed.sizeOfDataLocal += sizeOf(resolverData.returnData))
    : null;

  fsWrite('globalMetrics.json', globalMetricsParsed);
}

/*
-------------------------------------------------------------
LOCAL METRICS UPDATE FUNCTION: cacheRedis() {
  
}
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

  fsWrite('localMetricsStorage.json', parsedMetrics);
}

/*
-------------------------------------------------------------
GLOBAL METRICS FUNCTION: globalMetrics() {
  
}
Increments totalNumberOfRequests by one
Increments totalTimeSaved by the difference between the cached and uncached requests for that resolver
Updates amount of data saved locally
*/

function globalMetrics(resolverData, info, parsedMetrics) {
  const resolverName = info.path.key;
  const numOfResolvers = Object.keys(parsedMetrics).length;
  let globalMetricsParsed = fsRead('globalMetrics.json');

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

  fsWrite('globalMetrics.json', globalMetricsParsed);
}

/*
-------------------------------------------------------------
CLEAN STORAGE FUNCTION: clean() {
  
}
Checks if any data stored locally is set to expire, deletes it from localStorage if its expire property is greater than Date.now()
Updates local metrics for that resolver and global metrics
*/

function clean() {
  const dateNow = Date.now();

  let parsedData = fsRead('localStorage.json');
  let parsedGlobalData = fsRead('globalMetrics.json');
  let parsedLocalData = fsRead('localMetricsStorage.json');

  let sizeOfDeletedDataLocal = 0;

  for (let resolver in parsedData) {
    if (dateNow > parsedData[resolver].expire) {
      sizeOfDeletedDataLocal += parsedLocalData[resolver].dataSize;
      parsedLocalData[resolver].dataSize = 0;
      delete parsedData[resolver];
    }
  }

  client.info((req, res) => {
    res.split('\n').map((line) => {
      if (line.match(/used_memory:/)) {
        parsedGlobalData.sizeOfDataRedis = parseInt(line.split(':')[1]);
        parsedGlobalData.sizeOfDataLocal -= sizeOfDeletedDataLocal;

        fsWrite('globalMetrics.json', parsedGlobalData);
      }
    });
  });

  fsWrite('localStorage.json', parsedData);
  fsWrite('localMetricsStorage.json', parsedLocalData);
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
DATA SIZE FUNCTION: sizeOf() {
  
}
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
