import { handlers } from "../../src/mocks/handlers";

(globalThis as { handlers?: typeof handlers }).handlers = handlers;
