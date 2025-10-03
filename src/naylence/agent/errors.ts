class AgentException extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

class InvalidTaskException extends AgentException {}
class DuplicateTaskException extends AgentException {}
class UnsupportedOperationException extends AgentException {}
class AuthorizationException extends AgentException {}
class RateLimitExceededException extends AgentException {}
class NoDataFoundException extends AgentException {}
class ConflictException extends AgentException {}
class InvalidDataException extends AgentException {}
class TaskNotCancelableException extends AgentException {}
class PushNotificationNotSupportedException extends AgentException {}

export {
  AgentException,
  InvalidTaskException,
  DuplicateTaskException,
  UnsupportedOperationException,
  AuthorizationException,
  RateLimitExceededException,
  NoDataFoundException,
  ConflictException,
  InvalidDataException,
  TaskNotCancelableException,
  PushNotificationNotSupportedException,
};
