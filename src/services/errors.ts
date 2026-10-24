export class ServiceError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ServiceError";
  }
}

export const insufficientStock = (details: {
  productId: string;
  warehouseId: string;
  requested: number;
  available: number;
}) => new ServiceError("INSUFFICIENT_STOCK", details);

export const notFound = (entity: string, id?: string) =>
  new ServiceError("NOT_FOUND", { entity, id });

export const invalidState = (message: string, details?: Record<string, unknown>) =>
  new ServiceError(message, details);

export const forbidden = () => new ServiceError("FORBIDDEN");
