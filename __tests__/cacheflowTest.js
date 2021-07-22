const {
  testMsg,
  initCache,
  cache,
  cacheLocal,
  createClient,
} = require('../cacheflow.js');
const fs = require('fs');
const redis = require('redis');

describe('cacheflowql', () => {
  xdescribe('test message', () => {
    it('should return string: This is a test message from cacheflow', () => {
      expect(testMsg()).toEqual('This is a test message from cacheflow');
    });
  });

  xdescribe('init cache local', () => {
    beforeAll(() => {
      initCache({
        local: {
          checkExpire: 1,
          globalThreshold: 100,
        },
      });
    });

    it('should initialize an empty object to localMetricsStorage.json', () => {
      const localMetrics = fs.readFileSync('localMetricsStorage.json', 'utf-8');
      expect(localMetrics).toBe('{}');
    });
    it('should initialize a global metrics object to globalMetrics.json', () => {
      const defaultGlobalMetrics = {
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
      };
      const globalMetrics = fs.readFileSync('globalMetrics.json', 'utf-8');
      expect(globalMetrics).toBe(JSON.stringify(defaultGlobalMetrics));
    });
    it('should initialize a local storage file if cachConfig.local exists', () => {
      const LocalStorageData = fs.readFileSync(`localStorage.json`, 'utf-8');
      expect(LocalStorageData).toBe('{}');
    });
    it('should delete data from localStorage once maxAge is reached', async () => {
      const localStorage = fs.readFileSync('localStorage.json', 'utf-8');
      jest.useFakeTimers();
      let i = 0;
      while (i < 3) {
        await cache(
          { location: 'local', maxAge: 0.0 },
          { path: { key: 'hello' } },
          function () {
            return 1;
          }
        );
        i++;
      }
      let localStorageWithData = fs.readFileSync('localStorage.json', 'utf-8');
      await new Promise((r) => setTimeout(r, 2000));
      let localStorageAfterClean = fs.readFileSync(
        'localStorage.json',
        'utf-8'
      );

      expect(localStorage).toBe(localStorageAfterClean);
      expect(localStorage).not.toBe(localStorageWithData);
    });
  });

  describe('init cache redis', () => {
    xit('should throw an error if incorrect port', async () => {
      let client = await createClient({
        redis: {
          host: '127.0.0.1',
          port: '1111',
        },
      });
      await new Promise((r) => setTimeout(r, 4500));
      expect(client.connected).toBe(false);
    });

    xit('should throw an error if incorrect host', async () => {
      let client = await createClient({
        redis: {
          host: '127.1.1.1',
          port: '6379',
        },
      });
      await new Promise((r) => setTimeout(r, 4500));
      expect(client.connected).toBe(false);
    });

    it('should connect to redis if correct host and port and redis is set up with correct port and host', async () => {
      let client = await createClient({
        redis: {
          host: '127.0.0.1',
          port: '6379',
        },
      });
      await new Promise((r) => setTimeout(r, 4500));
      expect(client.connected).toBe(true);
      client.end(true);
    });
  });

  xdescribe('cache function', () => {
    describe('determine cache local', () => {
      it('should fire cacheLocal if user specified', async () => {
        expect(
          await cache(
            { location: 'local' },
            { path: { key: 'hello' } },
            function () {
              return 1;
            }
          )
        ).toEqual(1);
      });
      it('should cache data to localStorage.json if threshold triggered', async () => {
        for (let i = 0; i < 5; i++) {
          await cache(
            { location: 'local' },
            { path: { key: 'hello' } },
            function () {
              return 1;
            }
          );
        }

        expect(fs.readFileSync('localStorage.json', 'utf-8')).toEqual(
          '{"hello":{"data":1,"expire":null}}'
        );
      });
    });

    xdescribe('determine cache redis', () => {
      it('should fire cacheRedis if user specified', async () => {
        expect(
          await cache(
            { location: 'redis' },
            { path: { key: 'hello' } },
            function () {
              return 1;
            }
          )
        ).toEqual(1);
      });
      it('should cache data to localStorage.json if threshold triggered', async () => {
        for (let i = 0; i < 5; i++) {
          await cache(
            { location: 'local' },
            { path: { key: 'hello' } },
            function () {
              return 1;
            }
          );
        }

        expect(client.get('hello')).toEqual(true);
      });
    });
  });

  xdescribe('Metrics', () => {
    describe('Global Metrics', () => {
      it('should log global metrics to globalMetrics.json', () => {
        cache({ location: 'redis' }, { path: { key: 'hello' } }, function () {
          return 1;
        });

        expect(fs.readFileSync('globalMetrics.json', 'utf-8')).toEqual('');
      });
    });
  });
});
