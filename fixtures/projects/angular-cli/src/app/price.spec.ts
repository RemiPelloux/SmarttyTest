import { TestBed } from '@angular/core/testing';
import { Price } from './price';

describe('Price', () => {
  it('formats an amount', () => {
    expect(TestBed.inject(Price).format(12.5)).toBe('12.50 EUR');
  });
});
