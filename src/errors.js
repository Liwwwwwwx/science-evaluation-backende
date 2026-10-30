class TeamServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
module.exports = { TeamServiceError };
