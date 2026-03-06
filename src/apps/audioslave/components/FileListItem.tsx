import React, { useState, useEffect } from 'react';
import { QueueFile, TranscriptionStatus, StatusConfig } from '../types';
import { CheckIcon, ClockIcon, ErrorIcon, Mp3Icon, Mp4Icon, SpinnerIcon, ChevronDownIcon, ChevronUpIcon, EditIcon, SaveIcon } from './icons';

interface FileListItemProps {
  queueFile: QueueFile;
  onTranscriptUpdate: (id: string, newTranscript: string) => void;
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const STATUS_CONFIG: Record<Partial<TranscriptionStatus>, StatusConfig> = {
    [TranscriptionStatus.WAITING]: { text: "Waiting", icon: <ClockIcon />, color: "text-slate-400" },
    [TranscriptionStatus.TRANSCRIBING]: { text: "Transcribing...", icon: <SpinnerIcon />, color: "text-blue-400" },
    [TranscriptionStatus.COMPLETED]: { text: "Completed", icon: <CheckIcon />, color: "text-green-400" },
    [TranscriptionStatus.ERROR]: { text: "Error", icon: <ErrorIcon />, color: "text-red-400" },
}

const StatusIndicator: React.FC<{ status: TranscriptionStatus; statusDetail?: string; uploadProgress?: number }> = ({ status, statusDetail, uploadProgress }) => {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG[TranscriptionStatus.ERROR];
    let label = config.text;
    if (status === TranscriptionStatus.TRANSCRIBING && statusDetail) {
        label = (statusDetail.includes('Uploading') && uploadProgress !== undefined)
            ? statusDetail.replace('Uploading...', `Uploading ${uploadProgress}%`)
            : statusDetail;
    }
    return (
      <div className={`flex items-center gap-2 ${config.color}`}>
        {config.icon}
        <span className="hidden sm:inline">{label}</span>
      </div>
    );
};

const FileListItem: React.FC<FileListItemProps> = ({ queueFile, onTranscriptUpdate }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedTranscript, setEditedTranscript] = useState(queueFile.transcript || '');

  const { file, status, statusDetail, uploadProgress, warning, warningLevel, transcript, error } = queueFile;

  useEffect(() => {
    setEditedTranscript(transcript || '');
  }, [transcript]);

  const handleSave = () => {
    onTranscriptUpdate(queueFile.id, editedTranscript);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditedTranscript(transcript || '');
    setIsEditing(false);
  };

  const isExpandable = status === TranscriptionStatus.COMPLETED || status === TranscriptionStatus.ERROR;
  const fileType = file.type.startsWith('audio/') ? 'mp3' : 'mp4';

  return (
    <div className="bg-slate-800 rounded-lg shadow-lg overflow-hidden transition-all duration-300">
      <div className="flex items-center p-4">
        <div className="flex-shrink-0">
          {fileType === 'mp3' ? <Mp3Icon /> : <Mp4Icon />}
        </div>
        <div className="flex-grow mx-4 min-w-0">
          <p className="text-slate-200 font-medium truncate" title={file.name}>{file.name}</p>
          <p className="text-slate-500 text-sm">{formatFileSize(file.size)}</p>
        </div>
        <div className="flex-shrink-0 w-40 text-right">
          <StatusIndicator status={status} statusDetail={statusDetail} uploadProgress={uploadProgress} />
        </div>
        <div className="flex-shrink-0 ml-4">
          {isExpandable && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-2 rounded-full hover:bg-slate-700 transition-colors"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </button>
          )}
        </div>
      </div>
      {status === TranscriptionStatus.TRANSCRIBING && (
        <div className="w-full bg-slate-700 h-1">
          {statusDetail?.includes('Uploading') && uploadProgress !== undefined ? (
            <div
              className="bg-blue-500 h-1 transition-all duration-300 ease-out"
              style={{ width: `${uploadProgress}%` }}
            />
          ) : (
            <div className="bg-blue-500 h-1 animate-pulse" style={{ width: '100%' }} />
          )}
        </div>
      )}
      {warning && status === TranscriptionStatus.WAITING && (
        <div className={`mx-4 mb-3 px-3 py-2 rounded-md text-sm flex items-start gap-2 ${
            warningLevel === 'error'
                ? 'bg-red-900/30 text-red-300 border border-red-700/40'
                : 'bg-amber-900/20 text-amber-300 border border-amber-700/40'
        }`}>
          <span className="mt-0.5 flex-shrink-0">{warningLevel === 'error' ? '⚠' : 'ℹ'}</span>
          <span>{warning}</span>
        </div>
      )}
      {isExpanded && (transcript || error) && (
        <div className="p-4 border-t border-slate-700">
          {error && (
             <pre className="whitespace-pre-wrap break-words font-mono text-sm p-4 rounded-md bg-red-900/20 text-red-300">
                {error}
            </pre>
          )}
          {transcript && (
            <div>
              <div className="flex justify-between items-center mb-2">
                <h4 className="font-semibold text-slate-300">Transcript</h4>
                {isEditing ? (
                  <div className="flex gap-2">
                    <button onClick={handleSave} className="flex items-center gap-1 px-2 py-1 text-sm bg-green-600 hover:bg-green-700 rounded-md"><SaveIcon className="w-4 h-4" /> Save</button>
                    <button onClick={handleCancel} className="flex items-center gap-1 px-2 py-1 text-sm bg-slate-600 hover:bg-slate-700 rounded-md">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setIsEditing(true)} className="flex items-center gap-1 px-2 py-1 text-sm bg-blue-600 hover:bg-blue-700 rounded-md"><EditIcon className="w-4 h-4" /> Edit</button>
                )}
              </div>
              {isEditing ? (
                <textarea
                  value={editedTranscript}
                  onChange={(e) => setEditedTranscript(e.target.value)}
                  className="w-full h-48 p-2 font-mono text-sm bg-slate-900 rounded-md text-slate-300 border border-slate-600 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
              ) : (
                 <pre className="whitespace-pre-wrap break-words font-mono text-sm p-4 rounded-md bg-slate-900/50 text-slate-300">
                    {transcript}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FileListItem;
