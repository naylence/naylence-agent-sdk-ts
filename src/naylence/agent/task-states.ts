import { TaskState } from './a2a-types.js';

export const TERMINAL_TASK_STATES = new Set<TaskState>([
  TaskState.COMPLETED,
  TaskState.CANCELED,
  TaskState.FAILED,
]);
