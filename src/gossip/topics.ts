import type { AntibodyType } from "../types/antibody.js";

export const TOPIC_PREFIX = "immunity.antibody";
export const TOPIC_WILDCARD = `${TOPIC_PREFIX}.*` as const;

const TYPE_TO_SEGMENT: Record<AntibodyType, string> = {
  ADDRESS: "address",
  CALL_PATTERN: "call_pattern",
  BYTECODE: "bytecode",
  GRAPH: "graph",
  SEMANTIC: "semantic",
};

const SEGMENT_TO_TYPE: Record<string, AntibodyType> = {
  address: "ADDRESS",
  call_pattern: "CALL_PATTERN",
  bytecode: "BYTECODE",
  graph: "GRAPH",
  semantic: "SEMANTIC",
};

export function topicFor(abType: AntibodyType): string {
  return `${TOPIC_PREFIX}.${TYPE_TO_SEGMENT[abType]}`;
}

export function antibodyTypeFromTopic(topic: string): AntibodyType | null {
  if (!topic.startsWith(`${TOPIC_PREFIX}.`)) return null;
  const segment = topic.slice(TOPIC_PREFIX.length + 1);
  return SEGMENT_TO_TYPE[segment] ?? null;
}
