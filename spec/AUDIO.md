# Audio and editing

## Saved music

The original provider audio remains an internal source. For generated songs longer than five seconds, the saved playback copy removes the final five seconds. Very short clips remain playable. A successful result can retain MP3, WAV and FLAC variants when the provider supplies them. Vocal tracks save TXT lyrics, plus LRC when line timestamps are available; each file has its own download action.

## User audio and later edits

Users can upload a local audio file into their own library, then use it as the source for supported creation tools. A crop accepts precise start and end times, previews the selection and saves a separate linked track. Cropping uses local processing and preserves the source. Timed lyrics are shifted and clipped to the selected range.

## Acceptance

- The offline evaluation processes an 8-second WAV into a 3-second copy and confirms that the original SHA-256 is unchanged.
- Regression tests exercise WAV, MP3, FLAC and M4A processing; MP3 sample timing at 44.1 and 48 kHz; short clips; TXT/LRC generation; retries; uploads and crop boundaries.
- Evidence: `tests/postprocess.test.ts`, `tests/crop-audio.test.ts`, `tests/upload-music.test.ts`, `tests/library-tools.test.ts`.
