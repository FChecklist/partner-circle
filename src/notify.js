// Best-effort notification e-mails (approvals, payouts). Goes through the existing Resend setup only.
// Never throws: a notification must not be able to fail the money operation that triggered it. Sends only to a VERIFIED address.

export async function notify(ctx, userId, subject, text) {
  try {
    const u = await ctx.db.first('SELECT email, email_verified FROM users WHERE id=?', [userId]);
    if (!u?.email || !u.email_verified) return false;
    await ctx.mailer.send({ to: u.email, subject, text });
    return true;
  } catch {
    return false;
  }
}
