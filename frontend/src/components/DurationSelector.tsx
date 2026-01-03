interface DurationOption {
  value: number
  label: string
  description: string
}

const durations: DurationOption[] = [
  { value: 15, label: '15 min', description: 'Quick practice - 2-3 questions' },
  { value: 30, label: '30 min', description: 'Standard session - 4-6 questions' },
  { value: 45, label: '45 min', description: 'Extended session - 6-8 questions' },
  { value: 60, label: '60 min', description: 'Full interview - 8-10 questions' },
]

interface DurationSelectorProps {
  selected: number
  onChange: (duration: number) => void
}

export default function DurationSelector({ selected, onChange }: DurationSelectorProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {durations.map((duration) => (
        <button
          key={duration.value}
          onClick={() => onChange(duration.value)}
          className={`p-4 rounded-lg border-2 text-left transition-all ${
            selected === duration.value
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-200 hover:border-gray-300 bg-white'
          }`}
        >
          <div className={`text-xl font-bold ${
            selected === duration.value ? 'text-blue-600' : 'text-gray-900'
          }`}>
            {duration.label}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {duration.description}
          </div>
        </button>
      ))}
    </div>
  )
}
