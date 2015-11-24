'use strict';
var Benchmark = require('benchmark'),
    suite = new Benchmark.Suite(),
    FrameReader = require('../../lib/frames/frame_reader'),
    BufferList = require('bl');

suite
  .add('FrameReader#read', function() {
    var data = new BufferList(new Buffer('000000b402000000005312d0000000a40000000aa12e616d712e746f7069635f39653239343739362d303964372d343232632d613866652d38323863636563343035323152004250025000005328d0000000480000000ba109616d712e746f7069635200405200424040d10000002900000002a31664656661756c742d7375626a6563742d66696c74657200800000468c00000001a10123404040005329d00000000d00000007405200405200424040404052000000008702000000005312d0000000770000000aa12e616d712e746f7069635f34386566633466362d306165372d346531312d393737612d33386433313439313562636652014150025000005328d0000000110000000b40520040520042404040404040005329d00000001700000007a109616d712e746f7069635200405200424040404052000000002d02000000005313d00000001d000000095201707fffffff5200707fffffff5201520170000001f44042', 'hex'));

    FrameReader.read(data);
  })
  .on('cycle', function(event) { console.log(String(event.target)); })
  .on('error', function(err) { console.log(err); })
  .run();
