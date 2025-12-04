import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import JSZip from "jszip";
import { QueueFile, TranscriptionStatus } from './types';
import FileUploader from './components/FileUploader';
import FileListItem from './components/FileListItem';
import ProgressBar from './components/ProgressBar';
import ToggleSwitch from './components/ToggleSwitch';
import ExportControls from './components/ExportControls';
import { ClearIcon, TranscribeIcon } from './components/icons';

// --- Transcription Logic ---

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

const transcribeAudio = async (worker: Worker, ai: GoogleGenAI, file: File, enableDiarization: boolean): Promise<TranscriptionResult> => {
    try {
        const model = "gemini-2.0-flash-exp";

        const base64Data = await new Promise<string>((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<string>) => resolve(event.data);
            worker.onerror = (error) => reject(error);
            worker.postMessage(file);
        });

        let mimeType = file.type;
        if (!mimeType && file.name.toLowerCase().endsWith('.mkv')) {
            mimeType = 'video/x-matroska';
        }

        const audioPart = {
            inlineData: { data: base64Data, mimeType },
        };

        const textPrompt = enableDiarization
            ? "Transcribe this audio. Enable speaker diarization and label each speaker (e.g., [Speaker 1], [Speaker 2])."
            : "Transcribe this audio file.";

        const response = await ai.models.generateContent({
            model,
            contents: { parts: [audioPart, { text: textPrompt }] },
        });

        const transcript = response.text;

        if (transcript) {
            return { success: true, transcript };
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
    const workerRef = useRef<Worker | null>(null);

    useEffect(() => {
        workerRef.current = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        return () => {
            workerRef.current?.terminate();
        };
    }, []);


    const handleFilesAdded = (files: File[]) => {
        const newQueueFiles: QueueFile[] = files
            .filter(file => !queue.some(qf => qf.file.name === file.name && qf.file.size === file.size))
            .map(file => ({
                id: `${file.name}-${file.size}-${file.lastModified}`,
                file,
                status: TranscriptionStatus.WAITING,
            }));

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

        const transcriptionPromises = filesToTranscribe.map(async (queueFile) => {
            updateFileInQueue(queueFile.id, { status: TranscriptionStatus.TRANSCRIBING });
            const result = await transcribeAudio(workerRef.current!, aiClientRef.current!, queueFile.file, isSpeakerDetectionEnabled);

            if (result.success) {
                updateFileInQueue(queueFile.id, { status: TranscriptionStatus.COMPLETED, transcript: result.transcript });
            } else {
                updateFileInQueue(queueFile.id, { status: TranscriptionStatus.ERROR, error: result.error });
            }

            setProgressDetails(currentProgress => {
                const processed = (currentProgress?.processed || 0) + 1;
                return {
                    processed,
                    total,
                    percentage: Math.round((processed / total) * 100),
                };
            });
        });

        await Promise.all(transcriptionPromises);

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
            .map(qf => `--- TRANSCRIPT FOR: ${qf.file.name} ---\n\n${qf.transcript}\n\n`)
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
            zip.file(fileName, qf.transcript || '');
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
        let srtContent = '';
        let subtitleIndex = 1;
        completedFiles.forEach(qf => {
            const lines = qf.transcript?.split('\n').filter(line => line.trim() !== '');
            lines?.forEach((line, index) => {
                const startTime = new Date(index * 5000).toISOString().substr(11, 12).replace('.', ',');
                const endTime = new Date((index * 5000) + 4000).toISOString().substr(11, 12).replace('.', ',');
                srtContent += `${subtitleIndex++}\n${startTime} --> ${endTime}\n${line}\n\n`;
            });
        });

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
