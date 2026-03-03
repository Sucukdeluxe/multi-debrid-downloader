package com.sucukdeluxe.extractor;

import net.lingala.zip4j.ZipFile;
import net.lingala.zip4j.exception.ZipException;
import net.lingala.zip4j.model.FileHeader;
import net.sf.sevenzipjbinding.ExtractOperationResult;
import net.sf.sevenzipjbinding.IArchiveOpenCallback;
import net.sf.sevenzipjbinding.IArchiveOpenVolumeCallback;
import net.sf.sevenzipjbinding.IInArchive;
import net.sf.sevenzipjbinding.IInStream;
import net.sf.sevenzipjbinding.ISequentialOutStream;
import net.sf.sevenzipjbinding.ICryptoGetTextPassword;
import net.sf.sevenzipjbinding.PropID;
import net.sf.sevenzipjbinding.SevenZip;
import net.sf.sevenzipjbinding.SevenZipException;
import net.sf.sevenzipjbinding.impl.RandomAccessFileInStream;
import net.sf.sevenzipjbinding.impl.VolumedArchiveInStream;
import net.sf.sevenzipjbinding.simple.ISimpleInArchive;
import net.sf.sevenzipjbinding.simple.ISimpleInArchiveItem;

import java.io.Closeable;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public final class JBindExtractorMain {
    private static final int BUFFER_SIZE = 64 * 1024;
    private static final Pattern NUMBERED_ZIP_SPLIT_RE = Pattern.compile("(?i).*\\.zip\\.\\d{3}$");
    private static final Pattern OLD_ZIP_SPLIT_RE = Pattern.compile("(?i).*\\.z\\d{2,3}$");
    private static final Pattern SEVEN_ZIP_SPLIT_RE = Pattern.compile("(?i).*\\.7z\\.001$");
    private static final Pattern RAR_MULTIPART_RE = Pattern.compile("(?i).*\\.part\\d+\\.rar$");
    private static final Pattern RAR_OLDSPLIT_RE = Pattern.compile("(?i).*\\.r\\d{2,3}$");
    private static volatile boolean sevenZipInitialized = false;

    private JBindExtractorMain() {
    }

    public static void main(String[] args) {
        int exit = 1;
        try {
            ExtractionRequest request = parseArgs(args);
            exit = runExtraction(request);
        } catch (IllegalArgumentException error) {
            emitError("Argumentfehler: " + safeMessage(error));
            exit = 2;
        } catch (Throwable error) {
            emitError(safeMessage(error));
            exit = 1;
        }
        System.exit(exit);
    }

    private static int runExtraction(ExtractionRequest request) throws Exception {
        List<String> passwords = normalizePasswords(request.passwords);
        Exception lastError = null;
        boolean hadWrongPassword = false;
        for (String password : passwords) {
            try {
                extractSingle(request, password);
                emitPassword(password);
                emitDone();
                return 0;
            } catch (WrongPasswordException wrongPassword) {
                hadWrongPassword = true;
                lastError = wrongPassword;
            } catch (Exception error) {
                lastError = error;
                break;
            }
        }

        if (hadWrongPassword && (lastError instanceof WrongPasswordException)) {
            emitError("Falsches Archiv-Passwort");
            return 1;
        }
        if (lastError != null) {
            throw lastError;
        }
        emitError("Entpacken fehlgeschlagen");
        return 1;
    }

    private static void extractSingle(ExtractionRequest request, String password) throws Exception {
        Backend backend = request.backend;
        if (backend == Backend.AUTO) {
            backend = shouldUseZip4j(request.archiveFile) ? Backend.ZIP4J : Backend.SEVENZIPJBIND;
        }
        emitBackend(backend);

        if (backend == Backend.ZIP4J) {
            extractWithZip4j(request, password);
            return;
        }
        extractWithSevenZip(request, password);
    }

    private static void extractWithZip4j(ExtractionRequest request, String password) throws Exception {
        ZipFile zipFile = new ZipFile(request.archiveFile);
        try {
            if (password != null && password.length() > 0) {
                zipFile.setPassword(password.toCharArray());
            }

            List<FileHeader> fileHeaders = zipFile.getFileHeaders();
            if (fileHeaders == null) {
                fileHeaders = new ArrayList<FileHeader>();
            }

            long totalUnits = 0;
            boolean encrypted = false;
            for (FileHeader header : fileHeaders) {
                if (header == null || header.isDirectory()) {
                    continue;
                }
                encrypted = encrypted || header.isEncrypted();
                totalUnits += safeSize(header.getUncompressedSize());
            }
            ProgressTracker progress = new ProgressTracker(totalUnits);
            progress.emitStart();

            Set<String> reserved = new HashSet<String>();
            for (FileHeader header : fileHeaders) {
                if (header == null) {
                    continue;
                }

                String entryName = normalizeEntryName(header.getFileName(), "file");
                if (header.isDirectory()) {
                    File dir = resolveDirectory(request.targetDir, entryName);
                    ensureDirectory(dir);
                    reserved.add(pathKey(dir));
                    continue;
                }

                long itemUnits = safeSize(header.getUncompressedSize());
                File output = resolveOutputFile(request.targetDir, entryName, request.conflictMode, reserved);
                if (output == null) {
                    progress.advance(itemUnits);
                    continue;
                }

                ensureDirectory(output.getParentFile());
                long[] remaining = new long[] { itemUnits };
                try {
                    InputStream in = zipFile.getInputStream(header);
                    OutputStream out = new FileOutputStream(output);
                    try {
                        byte[] buffer = new byte[BUFFER_SIZE];
                        while (true) {
                            int read = in.read(buffer);
                            if (read < 0) {
                                break;
                            }
                            if (read == 0) {
                                continue;
                            }
                            out.write(buffer, 0, read);
                            long accounted = Math.min(remaining[0], (long) read);
                            remaining[0] -= accounted;
                            progress.advance(accounted);
                        }
                    } finally {
                        try {
                            out.close();
                        } catch (Throwable ignored) {
                        }
                        try {
                            in.close();
                        } catch (Throwable ignored) {
                        }
                    }
                    if (remaining[0] > 0) {
                        progress.advance(remaining[0]);
                    }
                    long modified = header.getLastModifiedTimeEpoch();
                    if (modified > 0) {
                        output.setLastModified(modified);
                    }
                } catch (ZipException error) {
                    if (isWrongPassword(error, encrypted)) {
                        throw new WrongPasswordException(error);
                    }
                    throw error;
                }
            }

            progress.emitDone();
        } finally {
            try {
                zipFile.close();
            } catch (Throwable ignored) {
            }
        }
    }

    private static synchronized void ensureSevenZipInitialized() throws Exception {
        if (sevenZipInitialized) {
            return;
        }
        SevenZip.initSevenZipFromPlatformJAR();
        sevenZipInitialized = true;
    }

    private static void extractWithSevenZip(ExtractionRequest request, String password) throws Exception {
        ensureSevenZipInitialized();
        SevenZipArchiveContext context = null;
        try {
            context = openSevenZipArchive(request.archiveFile, password);
            IInArchive archive = context.archive;
            ISimpleInArchive simple = archive.getSimpleInterface();
            ISimpleInArchiveItem[] items = simple.getArchiveItems();

            long totalUnits = 0;
            boolean encrypted = false;
            for (ISimpleInArchiveItem item : items) {
                if (item == null || item.isFolder()) {
                    continue;
                }
                try {
                    encrypted = encrypted || item.isEncrypted();
                } catch (Throwable ignored) {
                    // ignore encrypted flag read issues
                }
                totalUnits += safeSize(item.getSize());
            }
            ProgressTracker progress = new ProgressTracker(totalUnits);
            progress.emitStart();

            Set<String> reserved = new HashSet<String>();
            for (ISimpleInArchiveItem item : items) {
                if (item == null) {
                    continue;
                }

                String entryName = normalizeEntryName(item.getPath(), "item-" + item.getItemIndex());
                if (item.isFolder()) {
                    File dir = resolveDirectory(request.targetDir, entryName);
                    ensureDirectory(dir);
                    reserved.add(pathKey(dir));
                    continue;
                }

                long itemUnits = safeSize(item.getSize());
                File output = resolveOutputFile(request.targetDir, entryName, request.conflictMode, reserved);
                if (output == null) {
                    progress.advance(itemUnits);
                    continue;
                }

                ensureDirectory(output.getParentFile());
                final FileOutputStream out = new FileOutputStream(output);
                final long[] remaining = new long[] { itemUnits };
                try {
                    ExtractOperationResult result = item.extractSlow(new ISequentialOutStream() {
                        @Override
                        public int write(byte[] data) throws SevenZipException {
                            if (data == null || data.length == 0) {
                                return 0;
                            }
                            try {
                                out.write(data);
                            } catch (IOException error) {
                                throw new SevenZipException("Fehler beim Schreiben: " + error.getMessage(), error);
                            }
                            long accounted = Math.min(remaining[0], (long) data.length);
                            remaining[0] -= accounted;
                            progress.advance(accounted);
                            return data.length;
                        }
                    }, password == null ? "" : password);

                    if (remaining[0] > 0) {
                        progress.advance(remaining[0]);
                    }

                    if (result != ExtractOperationResult.OK) {
                        if (isPasswordFailure(result, encrypted)) {
                            throw new WrongPasswordException(new IOException("Falsches Passwort"));
                        }
                        throw new IOException("7z-Fehler: " + result.name());
                    }
                } catch (SevenZipException error) {
                    if (looksLikeWrongPassword(error, encrypted)) {
                        throw new WrongPasswordException(error);
                    }
                    throw error;
                } finally {
                    try {
                        out.close();
                    } catch (Throwable ignored) {
                    }
                }

                try {
                    java.util.Date modified = item.getLastWriteTime();
                    if (modified != null) {
                        output.setLastModified(modified.getTime());
                    }
                } catch (Throwable ignored) {
                    // best effort
                }
            }

            progress.emitDone();
        } finally {
            if (context != null) {
                context.close();
            }
        }
    }

    private static SevenZipArchiveContext openSevenZipArchive(File archiveFile, String password) throws Exception {
        String nameLower = archiveFile.getName().toLowerCase(Locale.ROOT);
        String effectivePassword = password == null ? "" : password;
        SevenZipVolumeCallback callback = new SevenZipVolumeCallback(archiveFile, effectivePassword);

        // Multi-volume archives need VolumedArchiveInStream so 7z-JBinding can
        // request additional volumes via the IArchiveOpenVolumeCallback.
        boolean isMultiVolume = SEVEN_ZIP_SPLIT_RE.matcher(nameLower).matches()
            || RAR_MULTIPART_RE.matcher(nameLower).matches()
            || hasOldStyleRarSplits(archiveFile);

        if (isMultiVolume) {
            VolumedArchiveInStream volumed = new VolumedArchiveInStream(archiveFile.getName(), callback);
            IInArchive archive = SevenZip.openInArchive(null, volumed, callback);
            return new SevenZipArchiveContext(archive, null, volumed, callback);
        }

        RandomAccessFile raf = new RandomAccessFile(archiveFile, "r");
        RandomAccessFileInStream stream = new RandomAccessFileInStream(raf);
        IInArchive archive = SevenZip.openInArchive(null, stream, callback);
        return new SevenZipArchiveContext(archive, stream, null, callback);
    }

    private static boolean hasOldStyleRarSplits(File archiveFile) {
        // Old-style RAR splits: main.rar + main.r01, main.r02, ...
        String name = archiveFile.getName();
        if (!name.toLowerCase(Locale.ROOT).endsWith(".rar")) {
            return false;
        }
        File parent = archiveFile.getParentFile();
        if (parent == null || !parent.exists()) {
            return false;
        }
        File[] siblings = parent.listFiles();
        if (siblings == null) {
            return false;
        }
        String stem = name.substring(0, name.length() - 4);
        for (File sibling : siblings) {
            if (!sibling.isFile()) {
                continue;
            }
            String sibName = sibling.getName();
            if (sibName.length() > stem.length() + 1 && sibName.substring(0, stem.length()).equalsIgnoreCase(stem)) {
                String suffix = sibName.substring(stem.length());
                if (RAR_OLDSPLIT_RE.matcher(suffix).matches() || suffix.toLowerCase(Locale.ROOT).matches("\\.r\\d{2,3}")) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isWrongPassword(ZipException error, boolean encrypted) {
        if (error == null) {
            return false;
        }
        if (error.getType() == ZipException.Type.WRONG_PASSWORD) {
            return true;
        }
        String text = safeMessage(error).toLowerCase(Locale.ROOT);
        if (text.contains("wrong password") || text.contains("falsches passwort")) {
            return true;
        }
        return encrypted && (text.contains("checksum") || text.contains("crc") || text.contains("password"));
    }

    private static boolean isPasswordFailure(ExtractOperationResult result, boolean encrypted) {
        if (!encrypted || result == null) {
            return false;
        }
        // Only DATAERROR reliably indicates wrong password. CRCERROR can also mean
        // a genuinely corrupt or incomplete archive, and 7z-JBinding sometimes
        // falsely reports encrypted=true for non-encrypted RAR files.
        return result == ExtractOperationResult.DATAERROR;
    }

    private static boolean looksLikeWrongPassword(Throwable error, boolean encrypted) {
        if (error == null) {
            return false;
        }
        String text = safeMessage(error).toLowerCase(Locale.ROOT);
        if (text.contains("wrong password") || text.contains("falsches passwort")) {
            return true;
        }
        // Only "data error" suggests wrong password. CRC errors can also mean
        // corrupt/incomplete archives, so we don't treat them as password failures.
        return encrypted && text.contains("data error");
    }

    private static boolean shouldUseZip4j(File archiveFile) {
        String name = archiveFile.getName().toLowerCase(Locale.ROOT);
        if (NUMBERED_ZIP_SPLIT_RE.matcher(name).matches()) {
            return true;
        }
        if (OLD_ZIP_SPLIT_RE.matcher(name).matches()) {
            return true;
        }
        if (name.endsWith(".zip")) {
            File parent = archiveFile.getParentFile();
            if (parent == null || !parent.exists()) {
                return false;
            }
            String stem = archiveFile.getName().substring(0, archiveFile.getName().length() - 4);
            File[] siblings = parent.listFiles();
            if (siblings == null) {
                return false;
            }
            String prefix = (stem + ".z").toLowerCase(Locale.ROOT);
            for (File sibling : siblings) {
                String siblingName = sibling.getName().toLowerCase(Locale.ROOT);
                if (!sibling.isFile()) {
                    continue;
                }
                if (siblingName.startsWith(prefix) && siblingName.length() >= prefix.length() + 2) {
                    String suffix = siblingName.substring(prefix.length());
                    if (suffix.matches("\\d{2,3}")) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static File resolveDirectory(File targetDir, String entryName) throws IOException {
        File directory = secureResolve(targetDir, entryName);
        return directory;
    }

    private static File resolveOutputFile(File targetDir, String entryName, ConflictMode conflictMode, Set<String> reserved) throws IOException {
        File base = secureResolve(targetDir, entryName);
        String key = pathKey(base);
        boolean exists = base.exists() || reserved.contains(key);

        if (!exists) {
            reserved.add(key);
            return base;
        }

        if (conflictMode == ConflictMode.SKIP) {
            return null;
        }

        if (conflictMode == ConflictMode.OVERWRITE) {
            if (base.exists()) {
                deleteRecursively(base);
            }
            reserved.add(key);
            return base;
        }

        File parent = base.getParentFile();
        String fileName = base.getName();
        int dot = fileName.lastIndexOf('.');
        String stem = dot > 0 ? fileName.substring(0, dot) : fileName;
        String ext = dot > 0 ? fileName.substring(dot) : "";

        int counter = 1;
        while (counter <= 10000) {
            String candidateName = stem + " (" + counter + ")" + ext;
            File candidate = new File(parent, candidateName);
            String candidateKey = pathKey(candidate);
            if (!candidate.exists() && !reserved.contains(candidateKey)) {
                reserved.add(candidateKey);
                return candidate;
            }
            counter += 1;
        }

        throw new IOException("Rename-Limit erreicht fur " + entryName);
    }

    private static void deleteRecursively(File file) throws IOException {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        if (!file.delete()) {
            throw new IOException("Konnte Datei nicht uberschreiben: " + file.getAbsolutePath());
        }
    }

    private static File secureResolve(File targetDir, String entryName) throws IOException {
        String normalized = normalizeEntryName(entryName, "file");
        while (normalized.startsWith("/")) {
            normalized = normalized.substring(1);
        }
        while (normalized.startsWith("\\")) {
            normalized = normalized.substring(1);
        }
        if (normalized.matches("^[a-zA-Z]:.*")) {
            normalized = normalized.substring(2);
        }
        File targetCanonical = targetDir.getCanonicalFile();
        File output = new File(targetCanonical, normalized);
        File outputCanonical = output.getCanonicalFile();
        String targetPath = targetCanonical.getPath();
        String outputPath = outputCanonical.getPath();
        String targetPathNorm = isWindows() ? targetPath.toLowerCase(Locale.ROOT) : targetPath;
        String outputPathNorm = isWindows() ? outputPath.toLowerCase(Locale.ROOT) : outputPath;
        if (!outputPathNorm.equals(targetPathNorm) && !outputPathNorm.startsWith(targetPathNorm + File.separator)) {
            throw new IOException("Path Traversal blockiert: " + entryName);
        }
        return outputCanonical;
    }

    private static String normalizeEntryName(String value, String fallback) {
        String entry = value == null ? "" : value.trim();
        if (entry.length() == 0) {
            return fallback;
        }
        entry = entry.replace('\\', '/');
        while (entry.startsWith("./")) {
            entry = entry.substring(2);
        }
        if (entry.length() == 0) {
            return fallback;
        }
        return entry;
    }

    private static long safeSize(Long value) {
        if (value == null) {
            return 1;
        }
        long size = value.longValue();
        if (size <= 0) {
            return 1;
        }
        return size;
    }

    private static void ensureDirectory(File dir) throws IOException {
        if (dir == null) {
            return;
        }
        if (dir.exists()) {
            if (!dir.isDirectory()) {
                throw new IOException("Pfad ist keine Directory: " + dir.getAbsolutePath());
            }
            return;
        }
        if (!dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("Verzeichnis konnte nicht erstellt werden: " + dir.getAbsolutePath());
        }
    }

    private static String pathKey(File file) {
        String value = file.getAbsolutePath();
        if (isWindows()) {
            value = value.toLowerCase(Locale.ROOT);
        }
        return value;
    }

    private static boolean isWindows() {
        String osName = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        return osName.contains("win");
    }

    private static List<String> normalizePasswords(List<String> input) {
        LinkedHashSet<String> deduped = new LinkedHashSet<String>();
        deduped.add("");
        if (input != null) {
            for (String value : input) {
                deduped.add(value == null ? "" : value);
            }
        }
        return new ArrayList<String>(deduped);
    }

    private static ExtractionRequest parseArgs(String[] args) {
        ExtractionRequest request = new ExtractionRequest();
        int index = 0;
        while (index < args.length) {
            String key = args[index];
            if ("--archive".equals(key)) {
                request.archiveFile = new File(readNext(args, ++index, key));
            } else if ("--target".equals(key)) {
                request.targetDir = new File(readNext(args, ++index, key));
            } else if ("--conflict".equals(key)) {
                request.conflictMode = ConflictMode.fromValue(readNext(args, ++index, key));
            } else if ("--backend".equals(key)) {
                request.backend = Backend.fromValue(readNext(args, ++index, key));
            } else if ("--password".equals(key)) {
                request.passwords.add(readNext(args, ++index, key));
            } else {
                throw new IllegalArgumentException("Unbekanntes Argument: " + key);
            }
            index += 1;
        }

        if (request.archiveFile == null) {
            throw new IllegalArgumentException("--archive fehlt");
        }
        if (request.targetDir == null) {
            throw new IllegalArgumentException("--target fehlt");
        }
        if (!request.archiveFile.exists() || !request.archiveFile.isFile()) {
            throw new IllegalArgumentException("Archiv nicht gefunden: " + request.archiveFile.getAbsolutePath());
        }
        return request;
    }

    private static String readNext(String[] args, int index, String key) {
        if (index >= args.length) {
            throw new IllegalArgumentException("Wert fehlt fur " + key);
        }
        return args[index];
    }

    private static String safeMessage(Throwable error) {
        if (error == null) {
            return "Unbekannter Fehler";
        }
        String message = error.getMessage();
        if (message == null || message.trim().length() == 0) {
            message = error.toString();
        }
        return message.replace('\n', ' ').replace('\r', ' ').trim();
    }

    private static void emitBackend(Backend backend) {
        System.out.println("RD_BACKEND " + backend.value);
    }

    private static void emitPassword(String password) {
        String encoded = Base64.getEncoder().encodeToString((password == null ? "" : password).getBytes(StandardCharsets.UTF_8));
        System.out.println("RD_PASSWORD " + encoded);
    }

    private static void emitDone() {
        System.out.println("RD_DONE");
    }

    private static void emitError(String message) {
        System.err.println("RD_ERROR " + message);
    }

    private enum Backend {
        AUTO("auto"),
        SEVENZIPJBIND("7zjbinding"),
        ZIP4J("zip4j");

        private final String value;

        Backend(String value) {
            this.value = value;
        }

        static Backend fromValue(String raw) {
            String value = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
            if ("auto".equals(value)) {
                return AUTO;
            }
            if ("7zjb".equals(value) || "7zjbinding".equals(value) || "sevenzipjbinding".equals(value)) {
                return SEVENZIPJBIND;
            }
            if ("zip4j".equals(value)) {
                return ZIP4J;
            }
            throw new IllegalArgumentException("Ungueltiger Backend-Wert: " + raw);
        }
    }

    private enum ConflictMode {
        OVERWRITE,
        SKIP,
        RENAME;

        static ConflictMode fromValue(String raw) {
            String value = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
            if ("overwrite".equals(value)) {
                return OVERWRITE;
            }
            if ("skip".equals(value) || "ask".equals(value)) {
                return SKIP;
            }
            if ("rename".equals(value)) {
                return RENAME;
            }
            throw new IllegalArgumentException("Ungueltiger Conflict-Wert: " + raw);
        }
    }

    private static final class ExtractionRequest {
        private File archiveFile;
        private File targetDir;
        private ConflictMode conflictMode = ConflictMode.SKIP;
        private Backend backend = Backend.AUTO;
        private final List<String> passwords = new ArrayList<String>();
    }

    private static final class WrongPasswordException extends Exception {
        private static final long serialVersionUID = 1L;

        WrongPasswordException(Throwable cause) {
            super(cause);
        }
    }

    private static final class ProgressTracker {
        private final long total;
        private long completed;
        private int lastPercent = -1;

        ProgressTracker(long totalUnits) {
            this.total = Math.max(1L, totalUnits);
            this.completed = 0L;
        }

        synchronized void emitStart() {
            emitPercent(0);
        }

        synchronized void advance(long units) {
            if (units <= 0) {
                return;
            }
            completed += units;
            if (completed > total) {
                completed = total;
            }
            int percent = (int) Math.min(100L, Math.max(0L, (completed * 100L) / total));
            emitPercent(percent);
        }

        synchronized void emitDone() {
            completed = total;
            emitPercent(100);
        }

        private void emitPercent(int percent) {
            int bounded = Math.max(0, Math.min(100, percent));
            if (bounded == lastPercent) {
                return;
            }
            lastPercent = bounded;
            System.out.println("RD_PROGRESS " + bounded + "%");
        }
    }

    private static final class SevenZipArchiveContext implements Closeable {
        private final IInArchive archive;
        private final IInStream rootStream;
        private final VolumedArchiveInStream volumedArchiveInStream;
        private final SevenZipVolumeCallback callback;

        SevenZipArchiveContext(IInArchive archive, IInStream rootStream, VolumedArchiveInStream volumedArchiveInStream, SevenZipVolumeCallback callback) {
            this.archive = archive;
            this.rootStream = rootStream;
            this.volumedArchiveInStream = volumedArchiveInStream;
            this.callback = callback;
        }

        @Override
        public void close() {
            if (archive != null) {
                try {
                    archive.close();
                } catch (Throwable ignored) {
                }
            }
            if (rootStream != null) {
                try {
                    rootStream.close();
                } catch (Throwable ignored) {
                }
            }
            if (volumedArchiveInStream != null) {
                try {
                    volumedArchiveInStream.close();
                } catch (Throwable ignored) {
                }
            }
            if (callback != null) {
                callback.close();
            }
        }
    }

    private static final class SevenZipVolumeCallback implements IArchiveOpenCallback, IArchiveOpenVolumeCallback, ICryptoGetTextPassword, Closeable {
        private final File archiveDir;
        private final String firstFileName;
        private final String password;
        private final Map<String, RandomAccessFile> openRafs = new HashMap<String, RandomAccessFile>();

        SevenZipVolumeCallback(File archiveFile, String password) {
            this.archiveDir = archiveFile.getAbsoluteFile().getParentFile();
            this.firstFileName = archiveFile.getName();
            this.password = password == null ? "" : password;
        }

        @Override
        public Object getProperty(PropID propID) {
            if (propID == PropID.NAME) {
                return firstFileName;
            }
            return null;
        }

        @Override
        public IInStream getStream(String filename) throws SevenZipException {
            File file = resolveVolumeFile(filename);
            if (file == null || !file.exists() || !file.isFile()) {
                return null;
            }
            try {
                String key = pathKey(file);
                RandomAccessFile raf = openRafs.get(key);
                if (raf == null) {
                    raf = new RandomAccessFile(file, "r");
                    openRafs.put(key, raf);
                }
                raf.seek(0L);
                return new RandomAccessFileInStream(raf);
            } catch (IOException error) {
                throw new SevenZipException("Volume konnte nicht geoffnet werden: " + filename, error);
            }
        }

        @Override
        public void setTotal(Long files, Long bytes) {
            // no-op
        }

        @Override
        public void setCompleted(Long files, Long bytes) {
            // no-op
        }

        @Override
        public String cryptoGetTextPassword() {
            return password;
        }

        private File resolveVolumeFile(String filename) {
            if (filename == null || filename.trim().length() == 0) {
                return null;
            }
            File direct = new File(filename);
            if (direct.isAbsolute() && direct.exists()) {
                return direct;
            }
            if (archiveDir != null) {
                File relative = new File(archiveDir, filename);
                if (relative.exists()) {
                    return relative;
                }
                File[] siblings = archiveDir.listFiles();
                if (siblings != null) {
                    for (File sibling : siblings) {
                        if (!sibling.isFile()) {
                            continue;
                        }
                        if (sibling.getName().equalsIgnoreCase(filename)) {
                            return sibling;
                        }
                    }
                }
            }
            return direct.exists() ? direct : null;
        }

        @Override
        public void close() {
            for (RandomAccessFile raf : openRafs.values()) {
                try {
                    raf.close();
                } catch (Throwable ignored) {
                }
            }
            openRafs.clear();
        }
    }
}
