export class HttpError extends Error {
  constructor(status, message, details = [], code = undefined) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details, 'bad_request');
export const unauthorized = (message = 'Sign-in required') => new HttpError(401, message, [], 'unauthorized');
export const forbidden = (message = 'You do not have access to this') => new HttpError(403, message, [], 'forbidden');
export const notFound = (message = 'Not found') => new HttpError(404, message, [], 'not_found');
export const conflict = (message, details) => new HttpError(409, message, details, 'conflict');
