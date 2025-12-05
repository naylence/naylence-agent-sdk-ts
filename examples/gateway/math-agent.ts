import { operation } from "@naylence/runtime";
import { BaseAgent } from "@naylence/agent-sdk";
import { FameMessageResponse } from "@naylence/core";

export class MathAgent extends BaseAgent {

  async onMessage(message: unknown): Promise<FameMessageResponse | null> {
    console.log("MessageAgent received message:", message);
    return null;
  }

  @operation()
  async add(params: { x: number; y: number }): Promise<number> {
    const { x, y } = params;
    return x + y;
  }

  @operation({ name: "multiply" })
  async multi(params: { x: number; y: number }): Promise<number> {
    const { x, y } = params;
    return x * y;
  }

  @operation({ name: "fib_stream", streaming: true })
  async *fib(params: { n: number }): AsyncGenerator<number> {
    const { n } = params;
    let a = 0;
    let b = 1;
    for (let i = 0; i < n; i++) {
      yield a;
      [a, b] = [b, a + b];
    }
  }
}
