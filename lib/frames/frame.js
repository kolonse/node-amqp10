'use strict';

var debug = require('debug')('amqp10:framing'),
    debugAMQP = require('debug')('amqp10:framing:amqp'),
    Builder = require('buffer-builder'),
    util = require('util'),

    codec = require('./../codec'),
    constants = require('./../constants'),
    errors = require('./../errors');



/**
 * Encapsulates all convenience methods required for encoding a frame to put it out on the wire, and decoding an
 * incoming frame.
 *
 * Frames look like:
 *
 <pre>
             +0       +1       +2       +3
        +-----------------------------------+ -.
      0 |                SIZE               |  |
        +-----------------------------------+  |-- > Frame Header
      4 |  DOFF  |  TYPE  | &lt;TYPE-SPECIFIC&gt; |  |      (8 bytes)
        +-----------------------------------+ -'
        +-----------------------------------+ -.
      8 |                ...                |  |
        .                                   .  |-- > Extended Header
        .          &lt;TYPE-SPECIFIC&gt;          .  |  (DOFF * 4 - 8) bytes
        |                ...                |  |
        +-----------------------------------+ -'
        +-----------------------------------+ -.
 4*DOFF |                                   |  |
        .                                   .  |
        .                                   .  |
        .                                   .  |
        .          &lt;TYPE-SPECIFIC&gt;          .  |-- > Frame Body
        .                                   .  |  (SIZE - DOFF * 4) bytes
        .                                   .  |
        .                                   .  |
        .                           ________|  |
        |                ...       |           |
        +--------------------------+          -'

 </pre>
 *
 * @constructor
 */
function Frame(frameType) {
  this.frameType = frameType;
}

Frame.prototype._getTypeSpecificHeader = function(options) {
  throw new errors.NotImplementedError('Subclass must override _getTypeSpecificHeader');
};

Frame.prototype._writeExtendedHeader = function(bufBuilder, options) {
  throw new errors.NotImplementedError('Subclass must override _writeExtendedHeader');
};

Frame.prototype._writePayload = function(bufBuilder, options) {
  throw new errors.NotImplementedError('Subclass must override _writePayload');
};

Frame.prototype.write = function(outStream, options) {
  var bufBuilder = new Builder();
  bufBuilder.appendUInt32BE(0); // Size placeholder

  // DOFF placeholder(8) | type(8) | type-specific(16)
  var doffHeader = ((this.frameType & 0xFF) << 16) | (this._getTypeSpecificHeader() & 0xFFFF);
  bufBuilder.appendUInt32BE(doffHeader);
  var extHeaderSize = this._writeExtendedHeader(bufBuilder, options);
  this._writePayload(bufBuilder, options);

  var buffer = bufBuilder.get();
  var headerSize = 8 + extHeaderSize;
  var size = buffer.length;
  var doff = headerSize / 4;

  // Now that we know size and DOFF, fill in the blanks.
  buffer.writeUInt32BE(size, 0);
  buffer.writeUInt8(doff, 4);

  debug('Sending frame: ' + this.constructor.name + ': ' + JSON.stringify(buffer) + ': ' + buffer.toString('hex'));
  outStream.write(buffer);
};

module.exports.Frame = Frame;



/**
 * AMQP Frames are slight variations on the one above, with the first part of the payload taken up
 * by the AMQP <i>performative</i> (details of the specific frame type).  For some frames, that's the entire payload.
 *
<pre>
      +0       +1       +2       +3
        +-----------------------------------+ -.
      0 |                SIZE               |  |
        +-----------------------------------+  |-- > Frame Header
      4 |  DOFF  |  TYPE  |     CHANNEL     |  |      (8 bytes)
        +-----------------------------------+ -'
        +-----------------------------------+ -.
      8 |                ...                |  |
        .                                   .  |-- > Extended Header
        .             &lt;IGNORED&gt;             .  |  (DOFF * 4 - 8) bytes
        |                ...                |  |
        +-----------------------------------+ -'
        +-----------------------------------+ -.
 4*DOFF |           PERFORMATIVE:           |  |
        .      Open / Begin / Attach        .  |
        .   Flow / Transfer / Disposition   .  |
        .      Detach / End / Close         .  |
        |-----------------------------------|  |
        .                                   .  |-- > Frame Body
        .                                   .  |  (SIZE - DOFF * 4) bytes
        .             PAYLOAD               .  |
        .                                   .  |
        .                           ________|  |
        |                ...       |           |
        +--------------------------+          -'

</pre>
 *
 * @constructor
 */
function AMQPFrame(channel) {
  AMQPFrame.super_.call(this, constants.frameType.amqp);
  this.channel = channel || 0;
}

util.inherits(AMQPFrame, Frame);

AMQPFrame.prototype._getTypeSpecificHeader = function(options) {
  return this.channel;
};

AMQPFrame.prototype._writeExtendedHeader = function(bufBuilder, options) {
  return 0; // AMQP doesn't use the extended header.
};


/**
 * Children should implement this method to translate their internal (friendly) representation into the
 * representation expected on the wire (a DescribedType(Descriptor, ...) with either a List of values
 * (ForcedType'd as necessary) or an object containing an encodeOrdering[] array to clarify ordering).
 *
 * @private
 */
AMQPFrame.prototype._getPerformative = function() {
  throw new errors.NotImplementedError('Children of AMQPFrame must implement this');
};


/**
 * AMQP Frames consist of two sections of payload - the performative, and the additional actual payload.
 * Some frames don't have any additional payload, but for those that do, they should override this to generate it.
 *
 * @private
 */
AMQPFrame.prototype._getAdditionalPayload = function() {
  return undefined;
};


/**
 * Used to populate the frame performative from a DescribedType pulled off the wire.
 *
 * @param {DescribedType} describedType     Details of the frame performative, should populate internal values.
 */
Frame.prototype.readPerformative = function(describedType) {
  throw new errors.NotImplementedError('Subclasses of AMQPrame must implement readPerformative');
};

AMQPFrame.prototype._writePayload = function(bufBuilder, options) {
  var performative = this._getPerformative();
  debugAMQP('Encoding performative: ' + JSON.stringify(performative));
  codec.encode(performative, bufBuilder);
  var payload = this._getAdditionalPayload();
  if (payload !== undefined) {
    bufBuilder.appendBuffer(payload);
  }
};

module.exports.AMQPFrame = AMQPFrame;
