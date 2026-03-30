import { TestBed } from '@angular/core/testing';

import { Vttsync } from './vttsync';

describe('Vttsync', () => {
  let service: Vttsync;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Vttsync);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
