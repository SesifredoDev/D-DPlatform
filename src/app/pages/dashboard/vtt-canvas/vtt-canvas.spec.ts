import { ComponentFixture, TestBed } from '@angular/core/testing';

import { VttCanvas } from './vtt-canvas';

describe('VttCanvas', () => {
  let component: VttCanvas;
  let fixture: ComponentFixture<VttCanvas>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VttCanvas]
    })
    .compileComponents();

    fixture = TestBed.createComponent(VttCanvas);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
