import React from 'react';

interface ProgressDetails {
    processed: number;
    total: number;
    percentage: number;
}

interface ProgressBarProps {
    details: ProgressDetails;
    isTranscribing: boolean;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ details, isTranscribing }) => {
    const { processed, total, percentage } = details;

    let statusText: string;
    if (isTranscribing) {
        statusText = `Transcribing... ${processed} of ${total} files`;
    } else if (percentage === 100) {
        statusText = `Completed! Transcribed ${total} of ${total} files.`;
    } else {
        statusText = `Interrupted. Processed ${processed} of ${total} files.`;
    }

    return (
        <div className="mb-4" role="progressbar" aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100} aria-label="Transcription Progress">
            <div className="flex justify-between mb-1">
                <span className="text-sm font-medium text-slate-300">{statusText}</span>
                <span className="text-sm font-medium text-slate-300">{percentage}%</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-2.5">
                <div 
                    className="bg-gradient-to-r from-blue-500 to-teal-400 h-2.5 rounded-full transition-all duration-500 ease-out" 
                    style={{ width: `${percentage}%` }}
                ></div>
            </div>
        </div>
    );
};

export default ProgressBar;
