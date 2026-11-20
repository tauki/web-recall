export type SourceReference = { index: number; url: string; title: string; timestamp?: number; versionId?: string };
export type ConversationTurn = { question: string; answer: string };
export type ConversationState = { schemaVersion: 1; scope: string; summary: string; turns: ConversationTurn[]; references: SourceReference[] };
export type AskPhase = 'preparing' | 'retrieving' | 'researching' | 'compacting' | 'answering' | 'completed' | 'insufficient_evidence' | 'failed' | 'cancelled';
export type AskRunState = { phase: AskPhase; sequence: number };
