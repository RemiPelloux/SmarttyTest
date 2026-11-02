import { Service } from '@angular/core';
import { environment } from '../environments/environment';

@Service()
export class Price {
  format(amount: number): string {
    return `${amount.toFixed(2)} ${environment.currency}`;
  }
}
