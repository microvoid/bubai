// Read the invitation created on the owner's phone, as an inbox link for the guest.
const login = http.post(AUTH_SERVER + '/api/auth/sign-in/email', {
  headers: { 'Content-Type': 'application/json', Origin: AUTH_SERVER },
  body: JSON.stringify({ email: 'roster-guest@example.test', password: TEST_PASSWORD }),
});
const token = json(login.body).token;
const invites = http.get(AUTH_SERVER + '/api/auth/organization/list-user-invitations', {
  headers: { Authorization: 'Bearer ' + token },
});
const invite = json(invites.body).find(i => i.status === 'pending' && i.organizationName === 'Roster owner');
if (!invite) throw new Error('Guest did not receive the invitation');
output.inviteId = invite.id;
