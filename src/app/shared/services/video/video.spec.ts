import { TestBed } from '@angular/core/testing';

import { Video } from './video';

describe('Video', () => {
  let service: Video;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Video);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
