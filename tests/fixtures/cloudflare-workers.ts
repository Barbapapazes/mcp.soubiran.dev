// Node tests use object handlers, not WorkerEntrypoint RPC. The OAuth library
// imports this class only to distinguish the two handler shapes.
export class WorkerEntrypoint {}
