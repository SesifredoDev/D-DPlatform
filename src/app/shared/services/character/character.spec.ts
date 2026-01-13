import { TestBed } from '@angular/core/testing';

import { ICharacter } from './character';

describe('Character', () => {
  let service: Character;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Character);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
