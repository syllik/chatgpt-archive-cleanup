import type { MutationRequest } from "./types.js";

export class FatalSafetyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FatalSafetyError";
  }
}

export function assertSafeMutation(request: MutationRequest): void {
  const method = request.method.toUpperCase();

  if (method === "DELETE") {
    throw new FatalSafetyError("DELETE is forbidden");
  }

  if (request.operation !== "archive-conversation") {
    throw new FatalSafetyError(`Unsupported mutation: ${request.operation}`);
  }

  if (!(["PATCH", "POST", "PUT"] as const).includes(method as "PATCH" | "POST" | "PUT")) {
    throw new FatalSafetyError(`Unsupported archive method: ${method}`);
  }
}
