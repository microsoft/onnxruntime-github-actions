const { Volume } = require('memfs');
const vol = Volume.fromJSON({});
// Export the memfs 'fs' interface and the volume itself
module.exports = { fs: require('memfs').createFsFromVolume(vol), vol };