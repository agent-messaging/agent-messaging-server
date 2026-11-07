/**
 * The A2A 1.0 data model and operation objects, in A2A's JSON form.
 *
 * Written by hand from `a2a.proto` (package `lf.a2a.v1`): field names are the
 * proto's in camelCase, enums travel as their names (`"TASK_STATE_WORKING"`,
 * `"ROLE_USER"`), bytes as base64 and timestamps as RFC 3339 in UTC (A2A
 * §5.6.1). The binding (bindings/a2a.md §6) carries these objects unchanged,
 * so nothing here is Agent Messaging's own.
 */

export type JsonObject = Record<string, unknown>;

export type TaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

export type Role = "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT";

/** One part of a Message or Artifact: exactly one of `text`, `raw` (base64),
 *  `url` or `data`, with optional `filename` and `mediaType` beside it. */
export interface Part {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: JsonObject;
  filename?: string;
  mediaType?: string;
}

export interface Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: Part[];
  metadata?: JsonObject;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: JsonObject;
  extensions?: string[];
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: JsonObject;
}

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: JsonObject;
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: JsonObject;
}

export interface AuthenticationInfo {
  scheme: string;
  credentials?: string;
}

export interface TaskPushNotificationConfig {
  tenant?: string;
  id?: string;
  taskId?: string;
  url: string;
  token?: string;
  authentication?: AuthenticationInfo;
}

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  taskPushNotificationConfig?: TaskPushNotificationConfig;
  historyLength?: number;
  returnImmediately?: boolean;
}

// ─── Agent Card ──────────────────────────────────────────────────────

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  tenant?: string;
  protocolVersion: string;
}

export interface AgentProvider {
  url: string;
  organization: string;
}

export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: JsonObject;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: JsonObject[];
}

export interface AgentCardSignature {
  protected: string;
  signature: string;
  header?: JsonObject;
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  provider?: AgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: AgentCapabilities;
  securitySchemes?: JsonObject;
  securityRequirements?: JsonObject[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  signatures?: AgentCardSignature[];
  iconUrl?: string;
}

// ─── Operation requests and responses (A2A §3, a2a.proto) ─────────────

export interface SendMessageRequest {
  tenant?: string;
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: JsonObject;
}

/** Exactly one of `task` or `message`. */
export interface SendMessageResponse {
  task?: Task;
  message?: Message;
}

/** One stream event: exactly one of the four. */
export interface StreamResponse {
  task?: Task;
  message?: Message;
  statusUpdate?: TaskStatusUpdateEvent;
  artifactUpdate?: TaskArtifactUpdateEvent;
}

export interface GetTaskRequest {
  tenant?: string;
  id: string;
  historyLength?: number;
}

export interface ListTasksRequest {
  tenant?: string;
  contextId?: string;
  status?: TaskState;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts?: boolean;
}

export interface ListTasksResponse {
  tasks: Task[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

export interface CancelTaskRequest {
  tenant?: string;
  id: string;
  metadata?: JsonObject;
}

export interface SubscribeToTaskRequest {
  tenant?: string;
  id: string;
}

export interface GetTaskPushNotificationConfigRequest {
  tenant?: string;
  taskId: string;
  id: string;
}

export interface DeleteTaskPushNotificationConfigRequest {
  tenant?: string;
  taskId: string;
  id: string;
}

export interface ListTaskPushNotificationConfigsRequest {
  tenant?: string;
  taskId: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ListTaskPushNotificationConfigsResponse {
  configs?: TaskPushNotificationConfig[];
  nextPageToken?: string;
}

export interface GetExtendedAgentCardRequest {
  tenant?: string;
}

/** The eleven operations, by A2A's name, with each one's request and result. */
export interface A2AOperations {
  SendMessage: { params: SendMessageRequest; result: SendMessageResponse };
  SendStreamingMessage: { params: SendMessageRequest; result: StreamResponse };
  GetTask: { params: GetTaskRequest; result: Task };
  ListTasks: { params: ListTasksRequest; result: ListTasksResponse };
  CancelTask: { params: CancelTaskRequest; result: Task };
  SubscribeToTask: { params: SubscribeToTaskRequest; result: StreamResponse };
  CreateTaskPushNotificationConfig: { params: TaskPushNotificationConfig; result: TaskPushNotificationConfig };
  GetTaskPushNotificationConfig: { params: GetTaskPushNotificationConfigRequest; result: TaskPushNotificationConfig };
  ListTaskPushNotificationConfigs: {
    params: ListTaskPushNotificationConfigsRequest;
    result: ListTaskPushNotificationConfigsResponse;
  };
  DeleteTaskPushNotificationConfig: { params: DeleteTaskPushNotificationConfigRequest; result: JsonObject };
  GetExtendedAgentCard: { params: GetExtendedAgentCardRequest; result: AgentCard };
}

export type A2AMethod = keyof A2AOperations;
