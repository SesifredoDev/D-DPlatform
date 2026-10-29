import { TestBed } from '@angular/core/testing';

import { Updater } from './updater';

describe('Updater', () => {
  let service: Updater;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Updater);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
