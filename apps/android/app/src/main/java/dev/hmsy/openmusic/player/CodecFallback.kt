package dev.hmsy.openmusic.player

import androidx.media3.common.PlaybackException

/** A disconnected network is not evidence against the codec. Keep the same item, position and cache key. */
internal fun needsCodecFallback(code: Int) = when (code) {
  PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
  PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
  PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
  PlaybackException.ERROR_CODE_DECODING_FAILED,
  PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
  PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED -> true
  else -> false
}
