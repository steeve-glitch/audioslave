import React from 'react';
import { DownloadIcon } from './icons';

interface ExportControlsProps {
  onDownloadTxt: () => void;
  onDownloadZip: () => void;
  onDownloadSrt: () => void;
  onDownloadJson: () => void;
  disabled?: boolean;
  txtFilename: string;
  onTxtFilenameChange: (value: string) => void;
  zipFilename: string;
  onZipFilenameChange: (value: string) => void;
  srtFilename: string;
  onSrtFilenameChange: (value: string) => void;
  jsonFilename: string;
  onJsonFilenameChange: (value: string) => void;
}

const ExportControls: React.FC<ExportControlsProps> = ({ 
  onDownloadTxt, 
  onDownloadZip, 
  onDownloadSrt,
  onDownloadJson,
  disabled = false,
  txtFilename,
  onTxtFilenameChange,
  zipFilename,
  onZipFilenameChange,
  srtFilename,
  onSrtFilenameChange,
  jsonFilename,
  onJsonFilenameChange
}) => {
  return (
    <div className="bg-slate-800/50 rounded-lg p-4 my-4 flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-300">Export Options</h3>
          <p className="text-sm text-slate-500">Download your completed transcripts.</p>
        </div>
        <div className="flex gap-4 flex-wrap">
          <button
            onClick={onDownloadTxt}
            disabled={disabled || !txtFilename.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-slate-600 text-white font-semibold rounded-lg shadow-md hover:bg-slate-700 disabled:bg-slate-500 disabled:cursor-not-allowed transition-colors duration-300"
          >
            <DownloadIcon />
            .txt
          </button>
          <button
            onClick={onDownloadZip}
            disabled={disabled || !zipFilename.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-slate-600 text-white font-semibold rounded-lg shadow-md hover:bg-slate-700 disabled:bg-slate-500 disabled:cursor-not-allowed transition-colors duration-300"
          >
            <DownloadIcon />
            .zip
          </button>
          <button
            onClick={onDownloadSrt}
            disabled={disabled || !srtFilename.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-slate-600 text-white font-semibold rounded-lg shadow-md hover:bg-slate-700 disabled:bg-slate-500 disabled:cursor-not-allowed transition-colors duration-300"
          >
            <DownloadIcon />
            .srt
          </button>
          <button
            onClick={onDownloadJson}
            disabled={disabled || !jsonFilename.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-slate-600 text-white font-semibold rounded-lg shadow-md hover:bg-slate-700 disabled:bg-slate-500 disabled:cursor-not-allowed transition-colors duration-300"
          >
            <DownloadIcon />
            .json
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-slate-700/50">
        <div>
          <label htmlFor="txt-filename" className="block text-sm font-medium text-slate-400 mb-1">
            .txt Filename
          </label>
          <div className="relative">
            <input
              type="text"
              id="txt-filename"
              value={txtFilename}
              onChange={(e) => onTxtFilenameChange(e.target.value)}
              disabled={disabled}
              className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-slate-200 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            />
            <span className="absolute inset-y-0 right-3 flex items-center text-slate-500">.txt</span>
          </div>
        </div>
        <div>
          <label htmlFor="zip-filename" className="block text-sm font-medium text-slate-400 mb-1">
            .zip Filename
          </label>
          <div className="relative">
            <input
              type="text"
              id="zip-filename"
              value={zipFilename}
              onChange={(e) => onZipFilenameChange(e.target.value)}
              disabled={disabled}
              className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-slate-200 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            />
            <span className="absolute inset-y-0 right-3 flex items-center text-slate-500">.zip</span>
          </div>
        </div>
        <div>
          <label htmlFor="srt-filename" className="block text-sm font-medium text-slate-400 mb-1">
            .srt Filename
          </label>
          <div className="relative">
            <input
              type="text"
              id="srt-filename"
              value={srtFilename}
              onChange={(e) => onSrtFilenameChange(e.target.value)}
              disabled={disabled}
              className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-slate-200 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            />
            <span className="absolute inset-y-0 right-3 flex items-center text-slate-500">.srt</span>
          </div>
        </div>
        <div>
          <label htmlFor="json-filename" className="block text-sm font-medium text-slate-400 mb-1">
            .json Filename
          </label>
          <div className="relative">
            <input
              type="text"
              id="json-filename"
              value={jsonFilename}
              onChange={(e) => onJsonFilenameChange(e.target.value)}
              disabled={disabled}
              className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-slate-200 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            />
            <span className="absolute inset-y-0 right-3 flex items-center text-slate-500">.json</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExportControls;