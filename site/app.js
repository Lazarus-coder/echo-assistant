const tabs = [...document.querySelectorAll('[role="tab"]')]

function activate(tab) {
  for (const item of tabs) {
    const selected = item === tab
    item.setAttribute('aria-selected', String(selected))
    item.tabIndex = selected ? 0 : -1
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => activate(tab))
  tab.addEventListener('keydown', (event) => {
    let index = tabs.indexOf(tab)
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') index = (index + 1) % tabs.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = tabs.length - 1
    else return
    event.preventDefault()
    activate(tabs[index])
    tabs[index].focus()
  })
}
