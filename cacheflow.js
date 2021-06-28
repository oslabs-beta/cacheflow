exports.testMsg = function () {
  console.log('This is a test message from cacheflow');
};

const track = {};

exports.cache = async function (cacheConfig, callback) {
  console.log('This is cache test message');
  const startDate = Date.now();
  if (typeof cacheConfig !== 'object' || Array.isArray(cacheConfig))
    throw new Error('Config object is invalid');

  // if (cacheConfig.location === 'local') {
  //   console.log('stored locally');

  //   if (track[cacheConfig.info.])

  //   const dataBack = await callback()
  // }

  const dataBack = await callback();

  console.log('Request latency: ', Date.now() - startDate, 'ms');

  return dataBack;
};
