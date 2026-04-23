export function normalizePhoneNumber(input: string) {
  const digits = input.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.startsWith("55")) return digits;
  return digits;
}

export function jidFromPhone(input: string) {
  return `${normalizePhoneNumber(input)}@s.whatsapp.net`;
}
