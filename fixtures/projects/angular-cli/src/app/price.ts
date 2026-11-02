import { Service } from '@angular/core';

@Service()
export class Price {
  format(amount: number): string {
    return `${amount.toFixed(2)} EUR`;
  }
}
