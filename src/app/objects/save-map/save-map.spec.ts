import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SaveMap } from './save-map';

describe('SaveMap', () => {
  let component: SaveMap;
  let fixture: ComponentFixture<SaveMap>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SaveMap]
    })
    .compileComponents();

    fixture = TestBed.createComponent(SaveMap);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
