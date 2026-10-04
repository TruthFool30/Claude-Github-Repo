// Living style guide at /ui-kit (not linked in navigation). Handy for module authors
// to see every shared component in both themes.
import { useState } from 'react';
import { Bell, CalendarDays, Heart, Image as ImageIcon, Pencil, Plus, Search, Share2, Trash2, Upload } from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  Avatar, AvatarStack, Badge, Button, Card, CardHeader, Checkbox, ColorPicker, EmptyState, Fab, Field, IconButton, ImageUploader,
  Input, Lightbox, MemberPicker, Menu, Modal, PageHeader, SegmentedControl, Select, Skeleton, SkeletonList, Spinner, Switch, Tabs,
  Textarea, toast, useConfirm,
} from '../ui';

const swatch = (a: string, b: string, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><text x="600" y="420" font-family="sans-serif" font-size="64" fill="white" text-anchor="middle">${label}</text></svg>`,
  )}`;
const images = [
  { src: swatch('#FF9A5A', '#E5484D', 'Beach day'), caption: 'Beach day ☀️' },
  { src: swatch('#6E6AF0', '#12A594', 'Mountains'), caption: 'Hiking trip' },
  { src: swatch('#D6409F', '#8E4EC6', 'Birthday'), caption: "Mia's birthday 🎂" },
];

export default function UiKit() {
  const { members } = useAuth();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [lb, setLb] = useState<number | null>(null);
  const [checked, setChecked] = useState(true);
  const [sw, setSw] = useState(true);
  const [seg, setSeg] = useState<'week' | 'month' | 'agenda'>('week');
  const [tab, setTab] = useState<'all' | 'mine' | 'done'>('all');
  const [picked, setPicked] = useState<number[]>(members.slice(0, 2).map((m) => m.id));
  const [color, setColor] = useState('#30A46C');
  const [cover, setCover] = useState<string | null>(null);

  return (
    <div>
      <PageHeader
        title="UI kit"
        subtitle="Shared components from src/ui"
        icon={Heart}
        actions={
          <>
            <Button variant="secondary" icon={Share2}>Share</Button>
            <Button icon={Plus} onClick={() => setOpen(true)}>Open modal</Button>
          </>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'all', label: 'All', count: 12 },
            { id: 'mine', label: 'Mine', count: 4 },
            { id: 'done', label: 'Done' },
          ]}
        />
      </PageHeader>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Buttons" icon={Pencil} />
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="soft">Soft</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger" icon={Trash2}>Delete</Button>
            <Button loading>Saving</Button>
            <Button size="sm" icon={Plus}>Small</Button>
            <Button size="lg">Large</Button>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <IconButton icon={Search} label="Search" />
            <IconButton icon={Bell} label="Notifications" variant="secondary" badge={3} />
            <IconButton icon={Plus} label="Add" variant="primary" />
            <Menu
              items={[
                { label: 'Edit', icon: Pencil, onSelect: () => toast.info('Edit') },
                { label: 'Share', icon: Share2, onSelect: () => toast.success('Shared!') },
                'divider',
                { label: 'Delete', icon: Trash2, danger: true, onSelect: () => toast.error('Deleted') },
              ]}
            />
            <Spinner className="text-primary" />
          </div>
        </Card>

        <Card>
          <CardHeader title="Form controls" icon={CalendarDays} accent="#0090FF" />
          <div className="flex flex-col gap-4">
            <Field label="Title" hint="Keep it short">
              <Input placeholder="Soccer practice" />
            </Field>
            <Field label="With error" error="This field is required">
              <Input icon={Search} placeholder="Search" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Repeat">
                <Select options={[{ value: 'none', label: 'Never' }, { value: 'weekly', label: 'Weekly' }]} />
              </Field>
              <Field label="Date">
                <Input type="date" />
              </Field>
            </div>
            <Field label="Notes">
              <Textarea placeholder="Anything to remember?" autoGrow />
            </Field>
            <Checkbox checked={checked} onChange={setChecked} label="Remind me" description="15 minutes before" />
            <Checkbox checked={checked} onChange={setChecked} shape="circle" color="#30A46C" label="Buy milk" />
            <Switch checked={sw} onChange={setSw} label="Share with family" description="Everyone can see this" />
            <SegmentedControl className="self-start" value={seg} onChange={setSeg} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'agenda', label: 'Agenda' }]} />
          </div>
        </Card>

        <Card>
          <CardHeader title="People" icon={Heart} accent="#D6409F" />
          <div className="flex flex-wrap items-end gap-3">
            {members[0] && (['xs', 'sm', 'md', 'lg', 'xl'] as const).map((s) => <Avatar key={s} user={members[0]} size={s} />)}
            <AvatarStack users={members} size="md" />
          </div>
          <div className="mt-5">
            <MemberPicker multiple showAll value={picked} onChange={setPicked} />
          </div>
          <div className="mt-5">
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Badge>Neutral</Badge>
            <Badge tone="primary">Primary</Badge>
            <Badge tone="success" dot>Done</Badge>
            <Badge tone="warning">Due soon</Badge>
            <Badge tone="danger">Overdue</Badge>
            <Badge tone="info">Info</Badge>
            <Badge color="#8E4EC6">Custom</Badge>
          </div>
        </Card>

        <Card>
          <CardHeader title="Images" icon={ImageIcon} accent="#F76B15" />
          <ImageUploader value={cover} onSelect={(f) => setCover(URL.createObjectURL(f))} onRemove={() => setCover(null)} aspect="16 / 7" />
          <div className="mt-4 grid grid-cols-3 gap-2">
            {images.map((img, i) => (
              <button key={i} type="button" onClick={() => setLb(i)} className="overflow-hidden rounded-xl">
                <img src={img.src} alt="" className="aspect-square w-full object-cover transition hover:scale-105" />
              </button>
            ))}
          </div>
          <div className="mt-4">
            <ImageUploader multiple onSelect={async () => new Promise((r) => setTimeout(r, 400))}>
              <Button variant="secondary" icon={Upload}>Upload photos</Button>
            </ImageUploader>
          </div>
        </Card>

        <Card>
          <CardHeader title="Loading" />
          <Skeleton className="mb-3 h-5 w-1/2" />
          <SkeletonList rows={3} />
        </Card>

        <Card padding="none">
          <EmptyState compact icon={CalendarDays} accent="#0090FF" title="No events yet" description="Add your first family event." action={<Button size="sm" icon={Plus}>Add event</Button>} />
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Feedback" />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => toast.success('Saved', { description: 'Your changes are live.' })}>Success toast</Button>
            <Button variant="secondary" onClick={() => toast.error('Could not save')}>Error toast</Button>
            <Button variant="secondary" onClick={() => toast.info('Item deleted', { action: { label: 'Undo', onClick: () => toast.success('Restored') } })}>Toast with action</Button>
            <Button
              variant="secondary"
              onClick={async () => {
                if (await confirm({ title: 'Delete this list?', message: 'All 12 items will be removed for everyone.', danger: true, confirmLabel: 'Delete' })) toast.success('Deleted');
              }}
            >
              Confirm dialog
            </Button>
          </div>
        </Card>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New event"
        description="Add something to the family calendar."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => { setOpen(false); toast.success('Event created'); }}>Create</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Title"><Input placeholder="Dentist" /></Field>
          <Field label="Who"><MemberPicker multiple value={picked} onChange={setPicked} /></Field>
          <Field label="Notes"><Textarea /></Field>
        </div>
      </Modal>
      <Lightbox images={images} index={lb} onClose={() => setLb(null)} onIndexChange={setLb} />
      <Fab label="Add" onClick={() => setOpen(true)} />
    </div>
  );
}
