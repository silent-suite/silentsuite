module.exports.ArgonType = { Argon2id: 2, Argon2d: 0, Argon2i: 1 }
module.exports.hash = function() {
  return Promise.reject(new Error('argon2-webworker disabled'))
}
