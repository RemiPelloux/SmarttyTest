export class FormatService {
  money(amount: number): string {
    return `${amount.toFixed(2)} EUR`;
  }
}
