import React, { useState, useRef, useCallback } from 'react';
import { UploadIcon } from './icons';

interface FileUploaderProps {
  onFilesAdded: (files: File[]) => void;
  disabled: boolean;
}

// Fix: Removed obsolete 'audio/mp3' MIME type. 'audio/mpeg' is the standard for MP3 files.
const acceptedFileTypes = ['audio/mpeg', 'video/mp4', 'video/x-matroska', 'video/mkv'];
const acceptedFileExtensions = ['.mp3', '.mp4', '.mkv'];

const FileUploader: React.FC<FileUploaderProps> = ({ onFilesAdded, disabled }) => {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      setIsDraggingOver(true);
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (disabled) return;

    const files = Array.from(e.dataTransfer.files).filter(file =>
      acceptedFileTypes.includes(file.type) || acceptedFileExtensions.some(ext => file.name.endsWith(ext))
    );
    if (files.length > 0) {
      onFilesAdded(files);
    }
  }, [disabled, onFilesAdded]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      onFilesAdded(files);
    }
  };

  const handleClick = () => {
    if (!disabled) {
      fileInputRef.current?.click();
    }
  };

  const borderStyle = isDraggingOver
    ? 'border-blue-400'
    : 'border-slate-600';

  return (
    <div
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex flex-col items-center justify-center p-8 sm:p-12 border-2 border-dashed ${borderStyle} rounded-xl bg-slate-800/50 transition-all duration-300 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-slate-800'}`}
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        multiple
        accept={acceptedFileExtensions.join(',')}
        className="hidden"
        disabled={disabled}
      />
      <UploadIcon />
      <p className="mt-4 text-lg font-semibold text-slate-300">
        Drag & Drop your files here
      </p>
      <p className="text-slate-500">or click to browse</p>
      <p className="mt-2 text-xs text-slate-600">Supports: .mp3, .mp4, .mkv</p>
    </div>
  );
};

export default FileUploader;