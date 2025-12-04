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
  transcript?: string;
  error?: string;
}

export interface StatusConfig {
    text: string;
    icon: ReactNode;
    color: string;
}
