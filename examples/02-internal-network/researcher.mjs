// The researcher's LangChain chain: a prompt, a chat model and a parser.
//
// The model here is LangChain's scripted test model, so the example runs with
// no API key. To use a real model, install its LangChain package and put it in
// place of FakeListChatModel, for example:
//
//   import { ChatAnthropic } from "@langchain/anthropic";
//   const model = new ChatAnthropic({ model: "<a model name>" });
//
// Nothing else changes: the mesh sees the same offering either way.

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { FakeListChatModel } from "@langchain/core/utils/testing";

export function researchChain() {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You gather three short, factual notes on a topic, one per line."],
    ["human", "Topic: {topic}"],
  ]);
  const model = new FakeListChatModel({
    responses: [
      [
        "- A message to an agent that is away waits in its mailbox on the mesh.",
        "- When the agent comes back it reads what waited, in order, and answers.",
        "- The sender needs no retry logic of its own.",
      ].join("\n"),
    ],
  });
  return prompt.pipe(model).pipe(new StringOutputParser());
}
