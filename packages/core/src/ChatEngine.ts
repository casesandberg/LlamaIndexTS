import { ChatMessage, OpenAI, ChatResponse, LLM } from "./LLM";
import { TextNode } from "./Node";
import {
  SimplePrompt,
  contextSystemPrompt,
  defaultCondenseQuestionPrompt,
  messagesToHistoryStr,
} from "./Prompt";
import { BaseQueryEngine } from "./QueryEngine";
import { Response } from "./Response";
import { BaseRetriever } from "./Retriever";
import { ServiceContext, serviceContextFromDefaults } from "./ServiceContext";
import { v4 as uuidv4 } from "uuid";
import { Event } from "./callbacks/CallbackManager";

interface ChatEngine {
  chatRepl(): void;

  achat(message: string, chatHistory?: ChatMessage[]): Promise<Response>;

  reset(): void;
}

export class SimpleChatEngine implements ChatEngine {
  chatHistory: ChatMessage[];
  llm: LLM;

  constructor(init?: Partial<SimpleChatEngine>) {
    this.chatHistory = init?.chatHistory ?? [];
    this.llm = init?.llm ?? new OpenAI();
  }

  chatRepl() {
    throw new Error("Method not implemented.");
  }

  async achat(message: string, chatHistory?: ChatMessage[]): Promise<Response> {
    chatHistory = chatHistory ?? this.chatHistory;
    chatHistory.push({ content: message, role: "user" });
    const response = await this.llm.achat(chatHistory);
    chatHistory.push(response.message);
    this.chatHistory = chatHistory;
    return new Response(response.message.content);
  }

  reset() {
    this.chatHistory = [];
  }
}

export class CondenseQuestionChatEngine implements ChatEngine {
  queryEngine: BaseQueryEngine;
  chatHistory: ChatMessage[];
  serviceContext: ServiceContext;
  condenseMessagePrompt: SimplePrompt;

  constructor(init: {
    queryEngine: BaseQueryEngine;
    chatHistory: ChatMessage[];
    serviceContext?: ServiceContext;
    condenseMessagePrompt?: SimplePrompt;
  }) {
    this.queryEngine = init.queryEngine;
    this.chatHistory = init?.chatHistory ?? [];
    this.serviceContext =
      init?.serviceContext ?? serviceContextFromDefaults({});
    this.condenseMessagePrompt =
      init?.condenseMessagePrompt ?? defaultCondenseQuestionPrompt;
  }

  private async acondenseQuestion(
    chatHistory: ChatMessage[],
    question: string
  ) {
    const chatHistoryStr = messagesToHistoryStr(chatHistory);

    return this.serviceContext.llmPredictor.apredict(
      defaultCondenseQuestionPrompt,
      {
        question: question,
        chat_history: chatHistoryStr,
      }
    );
  }

  async achat(
    message: string,
    chatHistory?: ChatMessage[] | undefined
  ): Promise<Response> {
    chatHistory = chatHistory ?? this.chatHistory;

    const condensedQuestion = await this.acondenseQuestion(
      chatHistory,
      message
    );

    const response = await this.queryEngine.aquery(condensedQuestion);

    chatHistory.push({ content: message, role: "user" });
    chatHistory.push({ content: response.response, role: "assistant" });

    return response;
  }

  chatRepl() {
    throw new Error("Method not implemented.");
  }

  reset() {
    this.chatHistory = [];
  }
}

export class ContextChatEngine implements ChatEngine {
  retriever: BaseRetriever;
  chatModel: OpenAI;
  chatHistory: ChatMessage[];

  constructor(init: {
    retriever: BaseRetriever;
    chatModel?: OpenAI;
    chatHistory?: ChatMessage[];
  }) {
    this.retriever = init.retriever;
    this.chatModel =
      init.chatModel ?? new OpenAI({ model: "gpt-3.5-turbo-16k" });
    this.chatHistory = init?.chatHistory ?? [];
  }

  chatRepl() {
    throw new Error("Method not implemented.");
  }

  async achat(message: string, chatHistory?: ChatMessage[] | undefined) {
    chatHistory = chatHistory ?? this.chatHistory;

    const parentEvent: Event = {
      id: uuidv4(),
      type: "wrapper",
      tags: ["final"],
    };
    const sourceNodesWithScore = await this.retriever.aretrieve(
      message,
      parentEvent
    );

    const systemMessage: ChatMessage = {
      content: contextSystemPrompt({
        context: sourceNodesWithScore
          .map((r) => (r.node as TextNode).text)
          .join("\n\n"),
      }),
      role: "system",
    };

    chatHistory.push({ content: message, role: "user" });

    const response = await this.chatModel.achat(
      [systemMessage, ...chatHistory],
      parentEvent
    );
    chatHistory.push(response.message);

    this.chatHistory = chatHistory;

    return new Response(
      response.message.content,
      sourceNodesWithScore.map((r) => r.node)
    );
  }

  reset() {
    this.chatHistory = [];
  }
}