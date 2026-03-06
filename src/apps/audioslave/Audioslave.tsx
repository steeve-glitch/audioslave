import React, { useState, useMemo, useRef, useCallback } from 'react';
import { GoogleGenAI, FileState } from "@google/genai";
import JSZip from "jszip";
import { QueueFile, TranscriptionStatus } from './types';
import FileUploader from './components/FileUploader';
import FileListItem from './components/FileListItem';
import ProgressBar from './components/ProgressBar';
import ToggleSwitch from './components/ToggleSwitch';
import ExportControls from './components/ExportControls';
import { ClearIcon, TranscribeIcon } from './components/icons';

// --- Transcription Logic ---

const INLINE_THRESHOLD = 15 * 1024 * 1024;   // 15 MB — above this, use Files API
const MAX_FILE_SIZE    = 2 * 1024 * 1024 * 1024; // 2 GB — hard Gemini Files API limit

const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = (error) => reject(error);
    });

const getMimeType = (file: File): string => {
    if (file.type) return file.type;
    if (file.name.toLowerCase().endsWith('.mkv')) return 'video/x-matroska';
    return 'application/octet-stream';
};

// --- Resumable upload with XHR progress events ---
interface UploadedFileInfo { name: string; uri: string; mimeType: string; }

const uploadFileWithProgress = (
    apiKey: string,
    file: File,
    mimeType: string,
    onProgress: (percent: number) => void,
): Promise<UploadedFileInfo> =>
    new Promise(async (resolve, reject) => {
        try {
            // Step 1: initiate a resumable upload session
            const initRes = await fetch(
                `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`,
                {
                    method: 'POST',
                    headers: {
                        'X-Goog-Upload-Protocol': 'resumable',
                        'X-Goog-Upload-Command': 'start',
                        'X-Goog-Upload-Header-Content-Type': mimeType,
                        'X-Goog-Upload-Header-Content-Length': String(file.size),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ file: { display_name: file.name } }),
                },
            );
            if (!initRes.ok) throw new Error(`Upload initiation failed: ${initRes.statusText}`);
            const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
            if (!uploadUrl) throw new Error('No upload URL returned by API.');

            // Step 2: stream the bytes, track progress with XHR
            const xhr = new XMLHttpRequest();
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        const f = data.file;
                        resolve({ name: f.name, uri: f.uri, mimeType: f.mimeType || mimeType });
                    } catch {
                        reject(new Error('Failed to parse upload response.'));
                    }
                } else {
                    reject(new Error(`Upload failed (${xhr.status}): ${xhr.statusText}`));
                }
            };
            xhr.onerror = () => reject(new Error('Upload network error.'));
            xhr.onabort = () => reject(new Error('Upload was aborted.'));
            xhr.open('POST', uploadUrl);
            xhr.setRequestHeader('Content-Length', String(file.size));
            xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
            xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
            xhr.send(file);
        } catch (err) {
            reject(err);
        }
    });

interface TranscriptionResult {
    success: boolean;
    transcript?: string;
    error?: string;
}

const handleApiError = (error: unknown): string => {
    console.error("Gemini API Error:", error);
    let errorMessage = "An unexpected error occurred.";
    if (error instanceof Error) {
        if (error.message.includes('API key not valid')) {
            errorMessage = "Invalid API key. Please check your .env file and ensure VITE_API_KEY is correct.";
        } else if (error.message.includes('quota')) {
            errorMessage = "API quota exceeded. Please check your usage limits.";
        } else if (error.message.includes('safety')) {
            errorMessage = "Content was blocked due to safety filters.";
        } else if (error.message.includes('503')) {
            errorMessage = "The service is temporarily unavailable. Please try again later.";
        } else if (error.message.includes('Invalid')) {
            errorMessage = "The audio format seems to be invalid or unsupported by the API.";
        } else {
            errorMessage = error.message;
        }
    }
    return errorMessage;
}

// --- Helper to convert JSON segments to SRT format ---
const jsonToSrt = (segments: { start: string; end: string; text: string }[]): string => {
    return segments.map((segment, index) => {
        return `${index + 1}\n${segment.start} --> ${segment.end}\n${segment.text.trim()}`;
    }).join('\n\n');
};

// --- Helper to strip SRT tags for plain text ---
const stripSrt = (srt: string): string => {
    // Remove timestamp lines (e.g., 00:00:01,000 --> 00:00:04,000)
    let text = srt.replace(/^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}.*$/gm, '');
    // Remove sequence numbers (digits on their own line)
    text = text.replace(/^\d+$/gm, '');
    // Remove empty lines and trim
    return text.split('\n').filter(line => line.trim() !== '').join('\n');
};

// --- Audio chunking for files > 2 GB ---

const CHUNK_DURATION_S = 20 * 60; // 20 minutes per chunk

// ADTS sampling frequency table (ISO 14496-3 Table 1.18)
const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Parse the first 2 bytes of an AudioSpecificConfig to recover AAC parameters
const parseAsc = (data: Uint8Array) => {
    const v = (data[0] << 8) | data[1];
    return {
        profile:       (v >> 11) & 0x1F, // audioObjectType
        samplingIndex: (v >>  7) & 0x0F,
        channelConfig: (v >>  3) & 0x0F,
    };
};

// Prepend a 7-byte ADTS header to every raw AAC frame and concatenate
const buildAdts = (frames: Uint8Array[], profile: number, samplingIndex: number, channelConfig: number): ArrayBuffer => {
    const adtsProfile = (profile - 1) & 0x3; // ADTS stores objectType−1
    const totalBytes = frames.reduce((s, f) => s + 7 + f.byteLength, 0);
    const out = new Uint8Array(totalBytes);
    let off = 0;
    for (const f of frames) {
        const len = 7 + f.byteLength;
        out[off]   = 0xFF;
        out[off+1] = 0xF1; // MPEG-4, Layer 00, no CRC
        out[off+2] = (adtsProfile << 6) | (samplingIndex << 2) | ((channelConfig >> 2) & 0x1);
        out[off+3] = ((channelConfig & 0x3) << 6) | ((len >> 11) & 0x3);
        out[off+4] = (len >> 3) & 0xFF;
        out[off+5] = ((len & 0x7) << 5) | 0x1F;
        out[off+6] = 0xFC;
        out.set(f, off + 7);
        off += len;
    }
    return out.buffer;
};

// Stream an MP4 through mp4box.js in 8 MB chunks, pull out every audio frame,
// and return them wrapped in ADTS — small enough for AudioContext.decodeAudioData
const extractAdtsFromMP4 = (file: File, onStatus: (s: string) => void): Promise<ArrayBuffer> =>
    new Promise(async (resolve, reject) => {
        try {
            const { default: MP4Box } = await import('mp4box');
            const mp4 = MP4Box.createFile();
            const frames: Uint8Array[] = [];
            let adtsParams: { profile: number; samplingIndex: number; channelConfig: number } | null = null;
            let audioTrackId: number | null = null;

            mp4.onReady = (info: any) => {
                const track = info.audioTracks?.[0];
                if (!track) { reject(new Error('No audio track found in this MP4.')); return; }
                audioTrackId = track.id;

                // Try to read AudioSpecificConfig from the esds box
                try {
                    const trak = mp4.getTrackById(track.id);
                    const ascRaw: unknown =
                        trak?.mdia?.minf?.stbl?.stsd?.entries?.[0]?.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
                    if (ascRaw instanceof Uint8Array && ascRaw.length >= 2) {
                        adtsParams = parseAsc(ascRaw);
                    }
                } catch { /* will use fallback */ }

                // Fallback: derive from track metadata
                if (!adtsParams) {
                    const sfIdx = ADTS_SAMPLE_RATES.indexOf(track.audio.sample_rate);
                    adtsParams = { profile: 2, samplingIndex: sfIdx >= 0 ? sfIdx : 3, channelConfig: track.audio.channel_count };
                }

                mp4.setExtractionOptions(audioTrackId, {}, { nbSamples: 10000 });
                mp4.start();
            };

            mp4.onSamples = (_id: number, _user: unknown, samples: any[]) => {
                for (const s of samples) frames.push(new Uint8Array(s.data));
            };

            mp4.onFlush = () => {
                if (!adtsParams) { reject(new Error('Could not read audio configuration from MP4.')); return; }
                try { resolve(buildAdts(frames, adtsParams.profile, adtsParams.samplingIndex, adtsParams.channelConfig)); }
                catch (e) { reject(e); }
            };

            mp4.onError = (e: string) => reject(new Error(`MP4 parse error: ${e}`));

            // Feed the file to mp4box in 8 MB slices — never loads the full file at once
            const CHUNK = 8 * 1024 * 1024;
            for (let start = 0; start < file.size; start += CHUNK) {
                const pct = Math.round((start / file.size) * 100);
                onStatus(`Extracting audio ${pct}%...`);
                const buf = await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer() as any;
                buf.fileStart = start;
                mp4.appendBuffer(buf);
            }
            mp4.flush();
        } catch (e) {
            reject(e);
        }
    });

// Adjust every timestamp in an SRT string by a fixed offset (seconds)
const parseSrtTime = (t: string): number => {
    const [hms, ms] = t.split(',');
    const [h, m, s] = hms.split(':').map(Number);
    return h * 3600 + m * 60 + s + Number(ms) / 1000;
};
const formatSrtTime = (total: number): string => {
    const ms  = Math.round((total % 1) * 1000);
    const sec = Math.floor(total);
    const s   = sec % 60;
    const m   = Math.floor(sec / 60) % 60;
    const h   = Math.floor(sec / 3600);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
};
const offsetSrt = (srt: string, offsetSec: number): string =>
    srt.replace(
        /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/g,
        (_, a, b) => `${formatSrtTime(parseSrtTime(a) + offsetSec)} --> ${formatSrtTime(parseSrtTime(b) + offsetSec)}`,
    );

// Concatenate multiple SRT strings, renumbering all sequence numbers
const mergeSrts = (srts: string[]): string => {
    let counter = 1;
    return srts
        .flatMap(srt =>
            srt.split('\n\n')
               .filter(b => b.trim())
               .map(block => {
                   const lines = block.trim().split('\n');
                   lines[0] = String(counter++);
                   return lines.join('\n');
               }),
        )
        .join('\n\n');
};

// Encode a slice of a decoded AudioBuffer as 16-bit PCM WAV
const encodeWav = (buffer: AudioBuffer, startSample: number, endSample: number): Blob => {
    const numCh      = buffer.numberOfChannels;
    const sr         = buffer.sampleRate;
    const numSamples = endSample - startSample;
    const dataBytes  = numSamples * numCh * 2; // 16-bit = 2 bytes
    const ab         = new ArrayBuffer(44 + dataBytes);
    const v          = new DataView(ab);
    const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

    str(0, 'RIFF'); v.setUint32(4,  36 + dataBytes, true);
    str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true);               // chunk size
    v.setUint16(20, 1,  true);               // PCM
    v.setUint16(22, numCh, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * numCh * 2, true);   // byte rate
    v.setUint16(32, numCh * 2, true);        // block align
    v.setUint16(34, 16, true);               // bits per sample
    str(36, 'data'); v.setUint32(40, dataBytes, true);

    let off = 44;
    for (let i = startSample; i < endSample; i++) {
        for (let ch = 0; ch < numCh; ch++) {
            const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
            v.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
            off += 2;
        }
    }
    return new Blob([ab], { type: 'audio/wav' });
};

const transcribeAudio = async (
    ai: GoogleGenAI,
    apiKey: string,
    file: File,
    enableDiarization: boolean,
    onStatus: (detail: string) => void,
    onUploadProgress: (percent: number) => void,
): Promise<TranscriptionResult> => {
    try {
        const model = "gemini-2.0-flash-exp";
        const mimeType = getMimeType(file);

        const schema = {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    start: { type: "STRING", description: "Start timestamp in SRT format (HH:MM:SS,mmm)" },
                    end: { type: "STRING", description: "End timestamp in SRT format (HH:MM:SS,mmm)" },
                    text: { type: "STRING", description: "The subtitle text content" },
                },
                required: ["start", "end", "text"],
            },
        };

        const textPrompt = enableDiarization
            ? "Transcribe this audio. Return a JSON array of subtitle segments. Each segment must have 'start', 'end' (in HH:MM:SS,mmm format), and 'text' fields. Enable speaker diarization and include speaker labels (e.g., [Speaker 1]) in the 'text' field. Keep segments short (max 2 lines, ~40 chars/line) for better readability."
            : "Transcribe this audio. Return a JSON array of subtitle segments. Each segment must have 'start', 'end' (in HH:MM:SS,mmm format), and 'text' fields. Keep segments short (max 2 lines, ~40 chars/line) for better readability.";

        // Helper: upload a WAV chunk blob, poll until active, transcribe, return offset-adjusted SRT
        const transcribeChunk = async (blob: Blob, chunkName: string, offsetSec: number, label: string): Promise<string> => {
            const chunkFile = new File([blob], chunkName, { type: 'audio/wav' });
            onStatus(`${label}: Uploading...`);
            onUploadProgress(0);
            const { name } = await uploadFileWithProgress(apiKey, chunkFile, 'audio/wav', onUploadProgress);
            onStatus(`${label}: Processing...`);
            let info = await ai.files.get({ name });
            while (info.state === FileState.PROCESSING) {
                await new Promise(r => setTimeout(r, 3000));
                info = await ai.files.get({ name });
            }
            if (info.state !== FileState.ACTIVE) throw new Error(`${label} processing failed (state: ${info.state}).`);
            onStatus(`${label}: Transcribing...`);
            const resp = await ai.models.generateContent({
                model,
                contents: { parts: [{ fileData: { fileUri: info.uri, mimeType: info.mimeType } }, { text: textPrompt }] },
                config: { responseMimeType: 'application/json', responseSchema: schema },
            } as any);
            ai.files.delete({ name }).catch(() => {});
            if (!resp.text) return '';
            try { return offsetSrt(jsonToSrt(JSON.parse(resp.text)), offsetSec); }
            catch { return ''; }
        };

        // Oversized path — demux MP4, decode audio-only ADTS, split into 20-min WAV chunks
        if (file.size > MAX_FILE_SIZE) {
            let decoded: AudioBuffer;
            try {
                const adtsBuffer = await extractAdtsFromMP4(file, onStatus);
                onStatus('Decoding audio...');
                const audioCtx = new AudioContext();
                decoded = await audioCtx.decodeAudioData(adtsBuffer);
                await audioCtx.close();
            } catch (e) {
                throw new Error(
                    `Could not extract/decode audio: ${e instanceof Error ? e.message : e}`,
                );
            }

            const samplesPerChunk = Math.floor(CHUNK_DURATION_S * decoded.sampleRate);
            const numChunks       = Math.ceil(decoded.length / samplesPerChunk);
            const chunkSrts: string[] = [];

            for (let i = 0; i < numChunks; i++) {
                const start     = i * samplesPerChunk;
                const end       = Math.min(start + samplesPerChunk, decoded.length);
                const offsetSec = start / decoded.sampleRate;
                const wav       = encodeWav(decoded, start, end);
                const chunkSrt  = await transcribeChunk(
                    wav, `${file.name}_chunk${i + 1}.wav`, offsetSec, `Chunk ${i + 1}/${numChunks}`,
                );
                if (chunkSrt) chunkSrts.push(chunkSrt);
            }
            return { success: true, transcript: mergeSrts(chunkSrts) };
        }

        let mediaPart: object;
        let uploadedFileName: string | undefined;

        if (file.size > INLINE_THRESHOLD) {
            // Large file — resumable upload with progress, then Files API URI
            onStatus('Uploading...');
            const { name, uri, mimeType: fileMimeType } = await uploadFileWithProgress(
                apiKey, file, mimeType, onUploadProgress,
            );
            uploadedFileName = name;

            // Poll until Gemini finishes processing the file
            onStatus('Processing...');
            let fileInfo = await ai.files.get({ name });
            while (fileInfo.state === FileState.PROCESSING) {
                await new Promise(r => setTimeout(r, 3000));
                fileInfo = await ai.files.get({ name });
            }
            if (fileInfo.state !== FileState.ACTIVE) {
                throw new Error(`File processing failed on Gemini servers (state: ${fileInfo.state}).`);
            }
            mediaPart = { fileData: { fileUri: fileInfo.uri ?? uri, mimeType: fileInfo.mimeType ?? fileMimeType } };
        } else {
            // Small file — inline base64
            onStatus('Processing...');
            const base64Data = await fileToBase64(file);
            mediaPart = { inlineData: { data: base64Data, mimeType } };
        }

        onStatus('Transcribing...');
        const response = await ai.models.generateContent({
            model,
            contents: { parts: [mediaPart, { text: textPrompt }] },
            config: {
                responseMimeType: "application/json",
                responseSchema: schema,
            }
        } as any);

        // Clean up the uploaded file from Gemini storage (best-effort)
        if (uploadedFileName) {
            ai.files.delete({ name: uploadedFileName }).catch(() => {});
        }

        const jsonText = response.text;
        if (jsonText) {
            try {
                const segments = JSON.parse(jsonText);
                return { success: true, transcript: jsonToSrt(segments) };
            } catch (parseError) {
                console.error("JSON Parse Error:", parseError);
                return { success: false, error: "Failed to parse transcription response." };
            }
        } else {
            return { success: false, error: "Transcription failed. The audio might be silent or could not be processed." };
        }
    } catch (error: unknown) {
        return { success: false, error: handleApiError(error) };
    }
};

// --- Types ---
interface ProgressDetails {
    processed: number;
    total: number;
    percentage: number;
}

// --- Main App ---

const Audioslave: React.FC = () => {
    const [queue, setQueue] = useState<QueueFile[]>([]);
    const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
    const [progressDetails, setProgressDetails] = useState<ProgressDetails | null>(null);
    const [isSpeakerDetectionEnabled, setIsSpeakerDetectionEnabled] = useState<boolean>(false);
    const [txtFilename, setTxtFilename] = useState('transcripts');
    const [zipFilename, setZipFilename] = useState('transcripts');
    const [srtFilename, setSrtFilename] = useState('transcripts');
    const [jsonFilename, setJsonFilename] = useState('transcripts');
    const [globalError, setGlobalError] = useState<string | null>(null);
    const aiClientRef = useRef<GoogleGenAI | null>(null);
    const apiKeyRef   = useRef<string | null>(null);

    const handleFilesAdded = (files: File[]) => {
        const newQueueFiles: QueueFile[] = files
            .filter(file => !queue.some(qf => qf.file.name === file.name && qf.file.size === file.size))
            .map(file => {
                let warning: string | undefined;
                let warningLevel: 'info' | 'error' | undefined;
                const mb = (file.size / (1024 * 1024)).toFixed(0);
                const gb = (file.size / (1024 * 1024 * 1024)).toFixed(2);
                if (file.size > MAX_FILE_SIZE) {
                    warning = `Large file (${gb} GB) — will be decoded and split into ~20-minute audio chunks for transcription. Requires ~${Math.ceil(file.size / (1024 ** 3) * 1.5)} GB of free RAM.`;
                    warningLevel = 'info';
                } else if (file.size > INLINE_THRESHOLD) {
                    warning = `Large file (${mb} MB) — will be uploaded to Gemini file storage first. This may take several minutes.`;
                    warningLevel = 'info';
                }
                return {
                    id: `${file.name}-${file.size}-${file.lastModified}`,
                    file,
                    status: TranscriptionStatus.WAITING,
                    warning,
                    warningLevel,
                };
            });

        if (newQueueFiles.length > 0) {
            setQueue(prev => [...prev, ...newQueueFiles]);
        }
    };

    const updateFileInQueue = useCallback((id: string, updates: Partial<QueueFile>) => {
        setQueue(prev =>
            prev.map(qf => (qf.id === id ? { ...qf, ...updates } : qf))
        );
    }, []);

    const handleTranscriptUpdate = useCallback((id: string, newTranscript: string) => {
        updateFileInQueue(id, { transcript: newTranscript });
    }, [updateFileInQueue]);


    const handleTranscribeAll = async () => {
        setGlobalError(null);
        setIsTranscribing(true);

        if (!aiClientRef.current) {
            try {
                const apiKey = import.meta.env.VITE_API_KEY;
                if (!apiKey) {
                    throw new Error("API key not found. Please ensure VITE_API_KEY is set in your .env file.");
                }
                apiKeyRef.current = apiKey;
                aiClientRef.current = new GoogleGenAI({ apiKey });
            } catch (error: any) {
                console.error("Failed to initialize GoogleGenAI:", error);
                const errorMessage = error.message || "Failed to initialize Gemini API client.";
                setGlobalError(errorMessage);
                const filesToUpdate = queue.filter(qf => qf.status === TranscriptionStatus.WAITING);
                filesToUpdate.forEach(qf => {
                    updateFileInQueue(qf.id, { status: TranscriptionStatus.ERROR, error: errorMessage });
                });
                setProgressDetails({ processed: filesToUpdate.length, total: filesToUpdate.length, percentage: 100 });
                setIsTranscribing(false);
                return;
            }
        }

        const filesToTranscribe = queue.filter(qf => qf.status === TranscriptionStatus.WAITING);
        const total = filesToTranscribe.length;
        if (total === 0) {
            setIsTranscribing(false);
            return;
        }

        setProgressDetails({ processed: 0, total, percentage: 0 });

        // Process files one at a time to avoid rate-limit errors and saturating upload bandwidth
        let processed = 0;
        for (const queueFile of filesToTranscribe) {
            updateFileInQueue(queueFile.id, { status: TranscriptionStatus.TRANSCRIBING, statusDetail: 'Starting...' });
            const result = await transcribeAudio(
                aiClientRef.current!,
                apiKeyRef.current!,
                queueFile.file,
                isSpeakerDetectionEnabled,
                (detail) => updateFileInQueue(queueFile.id, { statusDetail: detail }),
                (percent) => updateFileInQueue(queueFile.id, { uploadProgress: percent }),
            );

            if (result.success) {
                updateFileInQueue(queueFile.id, {
                    status: TranscriptionStatus.COMPLETED,
                    statusDetail: undefined,
                    uploadProgress: undefined,
                    transcript: result.transcript,
                });
            } else {
                updateFileInQueue(queueFile.id, {
                    status: TranscriptionStatus.ERROR,
                    statusDetail: undefined,
                    uploadProgress: undefined,
                    error: result.error,
                });
            }

            processed++;
            setProgressDetails({ processed, total, percentage: Math.round((processed / total) * 100) });
        }

        setIsTranscribing(false);
    };

    const handleClearAll = () => {
        if (!isTranscribing) {
            setQueue([]);
            setProgressDetails(null);
            setGlobalError(null);
        }
    };

    const completedFiles = useMemo(() =>
        queue.filter(qf => qf.status === TranscriptionStatus.COMPLETED && qf.transcript),
        [queue]);

    const handleDownloadTxt = () => {
        const content = completedFiles
            .map(qf => `--- TRANSCRIPT FOR: ${qf.file.name} ---\n\n${stripSrt(qf.transcript || '')}\n\n`)
            .join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${txtFilename.trim() || 'transcripts'}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDownloadZip = async () => {
        const zip = new JSZip();
        completedFiles.forEach(qf => {
            const fileName = qf.file.name.split('.').slice(0, -1).join('.') + '.txt';
            zip.file(fileName, stripSrt(qf.transcript || ''));
            // Also add the SRT file to the zip for convenience
            const srtName = qf.file.name.split('.').slice(0, -1).join('.') + '.srt';
            zip.file(srtName, qf.transcript || '');
        });
        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${zipFilename.trim() || 'transcripts'}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDownloadSrt = () => {
        // Since the transcript is now natively in SRT format, we just concatenate them
        const srtContent = completedFiles
            .map(qf => qf.transcript)
            .join('\n\n');

        const blob = new Blob([srtContent], { type: 'text/srt' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${srtFilename.trim() || 'transcripts'}.srt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDownloadJson = () => {
        const jsonContent = JSON.stringify(completedFiles, null, 2);
        const blob = new Blob([jsonContent], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${jsonFilename.trim() || 'transcripts'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const waitingFilesCount = useMemo(() => {
        return queue.filter(qf => qf.status === TranscriptionStatus.WAITING).length;
    }, [queue]);

    return (
        <div className="min-h-screen text-slate-200 flex flex-col items-center p-4 sm:p-6 md:p-8 font-sans">
            <div className="w-full max-w-4xl mx-auto">
                <header className="mb-8 text-center">
                    <h1 className="text-4xl sm:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-teal-300">
                        Audioslave
                    </h1>
                    <p className="text-slate-400 mt-2">Upload audio/video files and let Gemini transcribe them for you.</p>
                </header>
                <main>
                    {globalError && (
                        <div className="bg-red-900/30 border border-red-700/50 text-red-300 px-4 py-3 rounded-lg relative mb-4 shadow-lg" role="alert">
                            <div className="flex">
                                <div className="py-1">
                                    <svg className="fill-current h-6 w-6 text-red-400 mr-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M2.93 17.07A10 10 0 1 1 17.07 2.93 10 10 0 0 1 2.93 17.07zM11.414 10l2.829-2.828-1.415-1.415L10 8.586 7.172 5.757 5.757 7.172 8.586 10l-2.829 2.828 1.415 1.415L10 11.414l2.828 2.829 1.415-1.415L11.414 10z" /></svg>
                                </div>
                                <div>
                                    <p className="font-bold">A critical error occurred</p>
                                    <p className="text-sm">{globalError}</p>
                                </div>
                            </div>
                            <button onClick={() => setGlobalError(null)} className="absolute top-0 bottom-0 right-0 px-4 py-3" aria-label="Close error message">
                                <svg className="fill-current h-6 w-6 text-red-400/70 hover:text-red-400" role="button" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Close</title><path d="M14.348 14.849a1.2 1.2 0 0 1-1.697 0L10 11.819l-2.651 3.029a1.2 1.2 0 1 1-1.697-1.697l2.758-3.15-2.759-3.152a1.2 1.2 0 1 1 1.697-1.697L10 8.183l2.651-3.031a1.2 1.2 0 1 1 1.697 1.697l-2.758 3.152 2.758 3.15a1.2 1.2 0 0 1 0 1.698z" /></svg>
                            </button>
                        </div>
                    )}
                    <FileUploader onFilesAdded={handleFilesAdded} disabled={isTranscribing} />
                    {queue.length > 0 && (
                        <div className="mt-8">
                            <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
                                <h2 className="text-2xl font-semibold text-slate-300">Transcription Queue</h2>
                                <div className="flex gap-4 items-center">
                                    <ToggleSwitch
                                        label="Enable Speaker Detection"
                                        enabled={isSpeakerDetectionEnabled}
                                        onChange={setIsSpeakerDetectionEnabled}
                                        disabled={isTranscribing}
                                    />
                                    <button
                                        onClick={handleTranscribeAll}
                                        disabled={isTranscribing || waitingFilesCount === 0}
                                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700 disabled:bg-slate-500 disabled:cursor-not-allowed transition-colors duration-300"
                                    >
                                        <TranscribeIcon />
                                        Transcribe {waitingFilesCount > 0 ? `(${waitingFilesCount})` : ''} Files
                                    </button>
                                    <button
                                        onClick={handleClearAll}
                                        disabled={isTranscribing}
                                        className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-700 disabled:bg-slate-500 disabled:cursor-not-allowed transition-colors duration-300"
                                    >
                                        <ClearIcon />
                                        Clear All
                                    </button>
                                </div>
                            </div>

                            {progressDetails && progressDetails.total > 0 && (
                                <ProgressBar details={progressDetails} isTranscribing={isTranscribing} />
                            )}

                            {completedFiles.length > 0 && !isTranscribing && (
                                <ExportControls
                                    onDownloadTxt={handleDownloadTxt}
                                    onDownloadZip={handleDownloadZip}
                                    onDownloadSrt={handleDownloadSrt}
                                    onDownloadJson={handleDownloadJson}
                                    txtFilename={txtFilename}
                                    onTxtFilenameChange={setTxtFilename}
                                    zipFilename={zipFilename}
                                    onZipFilenameChange={setZipFilename}
                                    srtFilename={srtFilename}
                                    onSrtFilenameChange={setSrtFilename}
                                    jsonFilename={jsonFilename}
                                    onJsonFilenameChange={setJsonFilename}
                                />
                            )}

                            <div className="space-y-3 mt-4">
                                {queue.map(queueFile => (
                                    <FileListItem
                                        key={queueFile.id}
                                        queueFile={queueFile}
                                        onTranscriptUpdate={handleTranscriptUpdate}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </main>
            </div>
            <footer className="w-full max-w-4xl mx-auto text-center text-slate-500 mt-12 py-4 text-sm border-t border-slate-800">
                <p>Powered by React, Tailwind CSS, and the Google Gemini API.</p>
            </footer>
        </div>
    );
};

export default Audioslave;
