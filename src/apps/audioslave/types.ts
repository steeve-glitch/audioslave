import { ReactNode } from "react";

export enum TranscriptionStatus {
  WAITING = 'WAITING',
  TRANSCRIBING = 'TRANSCRIBING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export interface QueueFile {
  id: string;
  file: File;
  status: TranscriptionStatus;
  statusDetail?: string;
  uploadProgress?: number;        // 0-100 during the upload phase
  warning?: string;               // pre-flight warning shown on the queue item
  warningLevel?: 'info' | 'error';
  transcript?: string;
  error?: string;
}

export interface StatusConfig {
    text: string;
    icon: ReactNode;
    color: string;
}
