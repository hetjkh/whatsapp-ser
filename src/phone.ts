export function digitsOnlyPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}
