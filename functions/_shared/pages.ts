// Cloudflare Pages Functions – gemeinsamer Env-Typ und Handler-Signatur.
// Wird von den Handlern unter functions/api/*.ts importiert.

export type Env = {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
};

export type PagesContext = {
  request: Request;
  env: Env;
  // Weitere Felder (params, waitUntil, next, data, functionPath) sind
  // hier nicht typisiert, weil wir sie in den Handlern nicht brauchen.
};

export type PagesHandler = (context: PagesContext) => Promise<Response>;
