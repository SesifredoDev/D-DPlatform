import { TestBed } from '@angular/core/testing';

import { Dndbeyond } from './dndbeyond';

describe('Dndbeyond', () => {
  let service: Dndbeyond;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Dndbeyond);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
