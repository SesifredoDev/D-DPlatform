import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TextChannel } from './text-channel';

describe('TextChannel', () => {
  let component: TextChannel;
  let fixture: ComponentFixture<TextChannel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextChannel]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TextChannel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
