# JVM extractor runtime

This directory contains the Java sidecar runtime used by `src/main/extractor.ts`.

## Included backends

- `sevenzipjbinding` for the primary extraction path (RAR/7z/ZIP and others)
- `zip4j` for ZIP multipart handling (JD-style split ZIP behavior)

## Layout

- `classes/` compiled `JBindExtractorMain` classes
- `lib/` runtime jars required by the sidecar
- `src/` Java source for the sidecar

## Rebuild notes

The checked-in classes are Java 8 compatible and built from:

`resources/extractor-jvm/src/com/sucukdeluxe/extractor/JBindExtractorMain.java`

If you need to rebuild, compile against the jars in `lib/` with a Java 8-compatible compiler.
