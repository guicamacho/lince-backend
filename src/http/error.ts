/** An Error that carries an HTTP status for the app.ts error handler. */
export class HttpError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "HttpError";
  }
}
