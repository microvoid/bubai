const response = http.get(TARGET + '/test/observations');
const value = json(response.body);
if (value.unexpectedCreates !== 0 || value.receivedBearer) {
  throw new Error('Unexpected community creation or credential on the open workspace');
}
